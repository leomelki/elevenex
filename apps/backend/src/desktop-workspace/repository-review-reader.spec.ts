import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  rename,
  chmod,
  mkdir,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  RepositoryReviewReader,
  reviewGit,
  reviewQuery,
} from './repository-review-reader.js';
import type {
  RepositoryReviewFile,
  RepositoryReviewPage,
  RepositoryReviewQuery,
} from './repository-review.types.js';

jest.setTimeout(30000);

describe('task repository review against disposable Git repositories', () => {
  let cwd: string, reader: RepositoryReviewReader;
  const git = (args: string[]) => reviewGit(cwd, args);
  const write = (file: string, text: string | Buffer) =>
    writeFile(path.join(cwd, file), text);
  const read = (input: Partial<RepositoryReviewQuery> = {}) =>
    reader.read(
      cwd,
      7,
      { taskId: 7, requestId: 'test', source: 'uncommitted', ...input },
      'refs/heads/trunk',
    );
  const content = (
    page: RepositoryReviewPage,
    file: RepositoryReviewFile,
    input: Partial<RepositoryReviewQuery> = {},
  ) =>
    read({
      source: page.source,
      revision: page.revision,
      fileId: file.id,
      fileRev: file.rev,
      force: true,
      ...input,
    });
  const text = (page: RepositoryReviewPage) =>
    page.content?.hunks
      .flatMap((hunk) => hunk.lines)
      .map((line) => line.text)
      .join('\n');
  beforeEach(async () => {
    cwd = await mkdtemp(
      path.join(tmpdir(), 'elevenex-repository-review-test-'),
    );
    reader = new RepositoryReviewReader();
    await git(['init', '-b', 'trunk']);
    await git(['config', 'user.email', 'review@example.test']);
    await git(['config', 'user.name', 'Review']);
  });
  afterEach(async () => {
    reader.clear();
    await rm(cwd, { recursive: true, force: true });
  });
  const commit = async () => {
    await git(['add', '-A']);
    await git(['commit', '-m', 'change']);
  };

  it('separates staged, unstaged and untracked content without changing the index', async () => {
    await write('a.txt', 'base\n');
    await commit();
    await write('a.txt', 'staged\n');
    await git(['add', 'a.txt']);
    await write('a.txt', 'working\n');
    await write('new.txt', 'untracked\n');
    const before = await readFile(path.join(cwd, '.git/index'));
    const page = await read();
    expect(page.total).toBe(3);
    const staged = page.files.find((file) => file.layer === 'staged')!,
      unstaged = page.files.find((file) => file.layer === 'unstaged')!;
    expect(text(await content(page, staged))).toBe('base\nstaged');
    expect(text(await content(page, unstaged))).toBe('staged\nworking');
    expect(
      text(
        await content(
          page,
          page.files.find((file) => file.layer === 'untracked')!,
        ),
      ),
    ).toBe('untracked');
    expect(await readFile(path.join(cwd, '.git/index'))).toEqual(before);
    const stagedRev = staged.rev;
    await write('new.txt', 'changed again\n');
    const next = await read();
    expect(next.revision).not.toBe(page.revision);
    expect(next.files.find((file) => file.id === staged.id)?.rev).toBe(
      stagedRev,
    );
    await write('a.txt', 'moved\n');
    // Already cached content stays a coherent old revision. An uncached mode must reject a moving working file.
    await expect(content(page, unstaged, { mode: 'full' })).rejects.toThrow(
      /changed/,
    );
    expect(text(await content(page, staged, { mode: 'full' }))).toContain(
      'staged',
    );
  });
  it('handles unborn HEAD and root commits using empty-tree semantics', async () => {
    await write('first.txt', 'first\n');
    expect((await read({ source: 'last-commit' })).headSha).toBeNull();
    await git(['add', 'first.txt']);
    const unborn = await read();
    expect(unborn.files[0].layer).toBe('staged');
    expect(text(await content(unborn, unborn.files[0]))).toBe('first');
    await git(['commit', '-m', 'root']);
    const root = await read({ source: 'last-commit' });
    expect(root.explanation).toMatch(/Initial commit/);
    expect(root.files[0].add).toBe(1);
  });
  it('pins root/merge/rename/deletion/binary/mode metadata to commit objects', async () => {
    await write('old.txt', 'hello\n');
    await write('delete.txt', 'delete me\n');
    await write('script', 'echo yes\n');
    await commit();
    await git(['checkout', '-b', 'feature']);
    await rename(path.join(cwd, 'old.txt'), path.join(cwd, 'renamed.txt'));
    await rm(path.join(cwd, 'delete.txt'));
    await chmod(path.join(cwd, 'script'), 0o755);
    await write('binary', Buffer.from([0, 1, 2]));
    await commit();
    const page = await read({ source: 'last-commit' });
    expect(
      page.files.find((file) => file.path === 'renamed.txt'),
    ).toMatchObject({ status: 'R', oldPath: 'old.txt' });
    expect(page.files.find((file) => file.path === 'binary')?.binary).toBe(
      true,
    );
    expect(page.files.find((file) => file.path === 'script')).toMatchObject({
      oldMode: '100644',
      newMode: '100755',
    });
    expect(
      text(
        await content(page, page.files.find((file) => file.status === 'D')!),
      ),
    ).toContain('delete me');
    await git(['checkout', 'trunk']);
    await write('other', 'other\n');
    await commit();
    await git(['merge', '--no-ff', 'feature', '-m', 'merge']);
    const merge = await read({ source: 'last-commit' });
    expect(merge.explanation).toMatch(/first parent/);
    await write('renamed.txt', 'working edit must not leak\n');
    expect(
      text(
        await content(
          page,
          page.files.find((file) => file.path === 'renamed.txt')!,
          { mode: 'full' },
        ),
      ),
    ).toBe('hello');
    expect(merge.total).toBe(4);
  });
  it('compares committed branch changes with a resolved merge-base, including a moving/deleted target', async () => {
    await write('base', 'base\n');
    await commit();
    await git(['checkout', '-b', 'topic']);
    await write('topic', 'committed\n');
    await commit();
    await write('topic', 'working excluded\n');
    await write('untracked', 'excluded\n');
    const first = await read({ source: 'branch' });
    expect(first.total).toBe(1);
    expect(first.baseRef).toBe('refs/heads/trunk');
    expect(first.baseSha).not.toBe(first.headSha);
    expect(text(await content(first, first.files[0]))).toBe('committed');
    await git(['branch', '-f', 'trunk', 'HEAD']);
    const next = await read({ source: 'branch' });
    expect(next.total).toBe(0);
    expect(next.revision).not.toBe(first.revision);
    expect(text(await content(first, first.files[0]))).toBe('committed');
    await git(['branch', '-D', 'trunk']);
    await expect(read({ source: 'branch' })).rejects.toThrow(
      /missing or deleted/,
    );
    await expect(
      read({ source: 'branch', baseRef: 'missing' }),
    ).rejects.toThrow(/missing or deleted/);
  });
  it('bounds file lists and line windows while making every file searchable', async () => {
    await mkdir(path.join(cwd, 'files'));
    await Promise.all(
      Array.from({ length: 1005 }, (_, index) =>
        write(`files/${String(index).padStart(3, '0')}.txt`, 'one\n'),
      ),
    );
    const page = await read();
    expect(page.total).toBe(1005);
    expect(page.files.length).toBe(100);
    expect(page.nextOffset).toBe(100);
    const tail = await read({ revision: page.revision, offset: 1000 });
    expect(tail.files.length).toBe(5);
    expect(
      (await read({ revision: page.revision, query: '104' })).files[0].path,
    ).toBe('files/104.txt');
    await write(
      'large.txt',
      Array.from({ length: 1001 }, (_, index) => `line ${index}\n`).join(''),
    );
    const large = await read();
    const file =
      large.files.find((file) => file.path === 'large.txt') ??
      (await read({ revision: large.revision, query: 'large' })).files[0];
    const first = await content(large, file);
    expect(first.content?.hunks.flatMap((hunk) => hunk.lines).length).toBe(400);
    expect(first.content?.nextOffset).toBe(400);
    const second = await content(large, file, { lineOffset: 400 });
    expect(second.content?.hunks[0].lines[0].text).toBe('line 400');
  });
  it('rejects malformed windows, traversal, expired revisions and mismatched file revisions', async () => {
    for (const input of [
      { source: 'reply' },
      { source: 'branch', baseRef: '--output=/bad' },
      { source: 'uncommitted', offset: -1 },
      { source: 'uncommitted', context: 201 },
      { source: 'uncommitted', shell: 'bad' },
    ])
      expect(() => reviewQuery(input)).toThrow();
    await write('file', 'hello');
    const page = await read();
    await expect(
      content(page, page.files[0], { fileRev: 'f'.repeat(64) }),
    ).rejects.toThrow(/revision/);
    await expect(read({ revision: 'f'.repeat(64) })).rejects.toThrow(/expired/);
    const controller = new AbortController();
    controller.abort();
    await expect(
      reader.read(
        cwd,
        7,
        {
          source: 'uncommitted',
          taskId: 7,
          requestId: 'read',
          revision: page.revision,
        },
        null,
        controller.signal,
      ),
    ).rejects.toThrow(/cancelled/);
  });
  it('expands only the requested context gap and preserves stable line identities', async () => {
    const original =
      Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join(
        '\n',
      ) + '\n';
    await write('context.txt', original);
    await commit();
    await write(
      'context.txt',
      original
        .replace('line 30\n', 'changed 30\n')
        .replace('line 90\n', 'changed 90\n'),
    );
    const page = await read(),
      file = page.files[0];
    const initial = await content(page, file);
    const hunks = initial.content!.hunks;
    expect(hunks).toHaveLength(2);
    const expanded = await content(page, file, {
      expansions: [{ hunkId: hunks[0].id, before: 20, after: 0 }],
    });
    expect(expanded.content!.hunks[0].lines.length).toBe(
      hunks[0].lines.length + 20,
    );
    expect(expanded.content!.hunks[0].id).toBe(hunks[0].id);
    expect(expanded.content!.hunks[1]).toEqual(hunks[1]);
    const ids = expanded.content!.hunks.flatMap((hunk) =>
      hunk.lines.map((line) => line.id),
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const line of hunks[0].lines) expect(ids).toContain(line.id);
  });
  it('treats huge and binary content intentionally and never follows a reviewed symlink', async () => {
    await write('binary', Buffer.alloc(1_100_000));
    await symlink('/etc/hosts', path.join(cwd, 'link'));
    const page = await read(),
      binary = page.files.find((file) => file.path === 'binary')!,
      link = page.files.find((file) => file.path === 'link')!;
    expect(binary).toMatchObject({ large: true, countsExact: false });
    const deferred = await content(page, binary, { force: false });
    expect(deferred.content?.notice).toMatch(/Large file/);
    const loaded = await content(page, binary);
    expect(loaded.content?.notice).toMatch(/Binary/);
    expect(loaded.content?.hunks).toEqual([]);
    expect(text(await content(page, link))).toBe('/etc/hosts');
    await write('too-big', Buffer.alloc(9 * 1024 * 1024, 65));
    const large = await read({ query: 'too-big' });
    await expect(content(large, large.files[0])).rejects.toThrow(
      /8 MiB|preview limit/,
    );
  });
  it('reports unrelated histories and preserves filenames containing tabs and newlines', async () => {
    await write('base', 'base\n');
    await commit();
    await git(['checkout', '--orphan', 'unrelated']);
    await git(['rm', '-rf', '.']);
    await write('other', 'other\n');
    await commit();
    await git(['checkout', 'trunk']);
    await expect(
      read({ source: 'branch', baseRef: 'refs/heads/unrelated' }),
    ).rejects.toThrow(/unrelated histories/);
    await write('a\tb\nc.txt', 'safe\n');
    const page = await read();
    expect(page.files[0].path).toBe('a\tb\nc.txt');
    expect(text(await content(page, page.files[0]))).toBe('safe');
  });
  it('keeps native Git EOL and color rules consistent with metadata without touching the index', async () => {
    await git(['config', 'core.autocrlf', 'true']);
    await git(['config', 'color.ui', 'always']);
    await write('eol.txt', 'first\nsecond\n');
    await commit();
    await write('eol.txt', 'first\r\nchanged\r\n');
    const index = await readFile(path.join(cwd, '.git/index'));
    const page = await read(),
      file = page.files[0];
    expect(file).toMatchObject({ layer: 'unstaged', add: 1, del: 1 });
    const result = await content(page, file);
    const lines = result.content!.hunks.flatMap((hunk) => hunk.lines);
    expect(lines.filter((line) => line.kind === 'add')).toHaveLength(1);
    expect(lines.filter((line) => line.kind === 'del')).toHaveLength(1);
    expect(lines.some((line) => /\x1b\[/.test(line.text))).toBe(false);
    expect(await readFile(path.join(cwd, '.git/index'))).toEqual(index);
  });
  it('isolates pinned review identities when tasks refer to the same checkout', async () => {
    await write('shared.txt', 'review\n');
    const first = await read();
    const second = await reader.read(
      cwd,
      8,
      { taskId: 8, requestId: 'other-task', source: 'uncommitted' },
      null,
    );
    expect(first.revision).not.toBe(second.revision);
    expect(text(await content(first, first.files[0]))).toBe('review');
    expect(second.taskId).toBe(8);
  });
  it('reports unmerged index entries explicitly while committed sources remain reviewable', async () => {
    await write('conflict', 'base\n');
    await commit();
    await git(['checkout', '-b', 'left']);
    await write('conflict', 'left\n');
    await commit();
    await git(['checkout', 'trunk']);
    await write('conflict', 'right\n');
    await commit();
    await git(['merge', 'left']).catch(() => undefined);
    await expect(read()).rejects.toThrow(/unmerged entries/);
    expect((await read({ source: 'last-commit' })).files[0].path).toBe(
      'conflict',
    );
  });
  it('uses the repository object format for unborn and root-commit empty trees', async () => {
    const sha = path.join(cwd, 'sha256');
    await mkdir(sha);
    await reviewGit(sha, ['init', '--object-format=sha256', '-b', 'trunk']);
    await reviewGit(sha, ['config', 'user.name', 'Review']);
    await reviewGit(sha, ['config', 'user.email', 'review@example.test']);
    await writeFile(path.join(sha, 'file'), 'sha256\n');
    await reviewGit(sha, ['add', '-A']);
    const unborn = await reader.read(
      sha,
      7,
      { taskId: 7, requestId: 'sha', source: 'uncommitted' },
      null,
    );
    expect(unborn.files[0].layer).toBe('staged');
    expect(unborn.headSha).toBeNull();
    await reviewGit(sha, ['commit', '-m', 'root']);
    const root = await reader.read(
      sha,
      7,
      { taskId: 7, requestId: 'sha', source: 'last-commit' },
      null,
    );
    expect(root.headSha).toHaveLength(64);
    expect(root.baseSha).toHaveLength(64);
    expect(root.files[0].add).toBe(1);
  });
});
