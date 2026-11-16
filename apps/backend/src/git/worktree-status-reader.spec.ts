import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StatusResult } from 'simple-git';

import { worktreeSimpleGit } from '../config/system-paths.js';
import {
  configureWorktreeStatusReader,
  hasTrackedChanges,
  readWorktreeStatusDetailed,
  resetWorktreeStatusReader,
  trackedStatusPaths,
} from './worktree-status-reader.js';

jest.setTimeout(60_000);

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

function write(root: string, relativePath: string, content: string): void {
  const absolute = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

/** Order-insensitive view of a status, for comparing the two strategies. */
function normalize(status: StatusResult) {
  const sorted = (values: string[]) => [...values].sort();
  return {
    not_added: sorted(status.not_added),
    conflicted: sorted(status.conflicted),
    created: sorted(status.created),
    deleted: sorted(status.deleted),
    modified: sorted(status.modified),
    staged: sorted(status.staged),
    renamed: [...status.renamed].sort((a, b) => a.to.localeCompare(b.to)),
    files: status.files
      .map(({ path: filePath, index, working_dir, from }) => ({
        path: filePath,
        index,
        working_dir,
        from: from ?? null,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    current: status.current,
    tracking: status.tracking,
    ahead: status.ahead,
    behind: status.behind,
    detached: status.detached,
    isClean: status.isClean(),
  };
}

async function expectMatchesLegacy(
  worktreePath: string,
  strategy: 'untracked-cache' | 'full-scan' = 'untracked-cache',
) {
  const read = await readWorktreeStatusDetailed(worktreePath);
  expect(read.strategy).toBe(strategy);
  if (strategy === 'full-scan') expect(read.fallbackReason).toBeTruthy();
  else expect(read.fallbackReason).toBeNull();
  const legacy = await worktreeSimpleGit(worktreePath).status();
  expect(normalize(read.status)).toEqual(normalize(legacy));
  return read;
}

describe('worktree status reader', () => {
  let tmpDir: string;
  let repo: string;

  beforeEach(() => {
    configureWorktreeStatusReader({ indexSettleMs: 0 });
    resetWorktreeStatusReader();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-reader-'));
    repo = path.join(tmpDir, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'core.hooksPath', '/dev/null');
    git(repo, 'config', 'commit.gpgSign', 'false');
    write(repo, '.gitignore', 'ignored_dir/\n*.log\n!keep.log\n');
    write(repo, 'tracked/a.txt', 'a\n');
    write(repo, 'tracked/deep/b.txt', 'b\n');
    write(repo, 'rename-me.txt', 'rename me\n'.repeat(20));
    write(repo, 'delete-me.txt', 'delete me\n');
    write(repo, 'staged-delete.txt', 'staged delete\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
  });

  afterEach(() => {
    configureWorktreeStatusReader(null);
    resetWorktreeStatusReader();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns exactly what simple-git status returns, for every kind of change', async () => {
    // Staged changes.
    write(repo, 'tracked/a.txt', 'a staged\n');
    git(repo, 'add', 'tracked/a.txt');
    git(repo, 'mv', 'rename-me.txt', 'renamed.txt');
    git(repo, 'rm', '-q', 'staged-delete.txt');
    write(repo, 'new-staged.txt', 'new\n');
    git(repo, 'add', 'new-staged.txt');
    // Unstaged on top of staged, plain unstaged, deleted, intent-to-add.
    write(repo, 'tracked/a.txt', 'a staged then edited\n');
    write(repo, 'tracked/deep/b.txt', 'b edited\n');
    fs.rmSync(path.join(repo, 'delete-me.txt'));
    write(repo, 'intent.txt', 'intent\n');
    git(repo, 'add', '-N', 'intent.txt');
    // Untracked: top-level, inside tracked dirs, whole new trees, odd names.
    write(repo, 'top.txt', 'top\n');
    write(repo, 'tracked/deep/new.txt', 'new\n');
    write(repo, 'newdir/a/b/x.txt', 'x\n');
    write(repo, 'newdir/y.txt', 'y\n');
    write(repo, 'newdir/skip.log', 'ignored\n');
    write(repo, 'newdir/keep.log', 'kept by negation\n');
    write(repo, 'only-ignored/i.log', 'ignored\n');
    write(repo, 'ignored_dir/q.txt', 'ignored\n');
    write(repo, 'sp ace/[x]*?/f :x.txt', 'glob characters\n');
    write(repo, 'ünïcödé/ü.txt', 'unicode\n');
    write(repo, 'trailing/space.txt ', 'trailing space\n');
    fs.mkdirSync(path.join(repo, 'empty/sub'), { recursive: true });
    fs.symlinkSync('tracked', path.join(repo, 'link-to-dir'));
    fs.symlinkSync('nowhere', path.join(repo, 'broken-link'));
    // A nested repository is listed as a single directory entry.
    fs.mkdirSync(path.join(repo, 'nested'));
    git(path.join(repo, 'nested'), 'init', '-q');
    write(repo, 'nested/inner.txt', 'inner\n');

    await expectMatchesLegacy(repo);
    // The second read uses the untracked cache saved by the first.
    await expectMatchesLegacy(repo);
  });

  it('sees untracked files created after the cache was saved', async () => {
    write(repo, 'newdir/one.txt', '1\n');
    await expectMatchesLegacy(repo);

    write(repo, 'newdir/two.txt', '2\n');
    write(repo, 'tracked/deep/later.txt', 'later\n');
    write(repo, 'brand/new/tree.txt', 'tree\n');
    await expectMatchesLegacy(repo);

    fs.rmSync(path.join(repo, 'newdir'), { recursive: true });
    await expectMatchesLegacy(repo);
  });

  it('follows index changes made by other git commands', async () => {
    write(repo, 'tracked/a.txt', 'edited\n');
    await expectMatchesLegacy(repo);

    git(repo, 'add', 'tracked/a.txt');
    const staged = await expectMatchesLegacy(repo);
    expect(staged.status.staged).toEqual(['tracked/a.txt']);

    git(repo, 'commit', '-q', '-m', 'commit');
    const committed = await expectMatchesLegacy(repo);
    expect(committed.status.isClean()).toBe(true);
  });

  it('never writes the real index or takes its lock', async () => {
    const indexPath = path.join(repo, '.git', 'index');
    const before = fs.statSync(indexPath, { bigint: true });
    // Touch tracked files so Git wants to refresh their stat data.
    for (const file of ['tracked/a.txt', 'tracked/deep/b.txt']) {
      const absolute = path.join(repo, file);
      fs.utimesSync(absolute, new Date(), new Date(Date.now() + 5_000));
    }
    write(repo, 'untracked/file.txt', 'u\n');

    await expectMatchesLegacy(repo);
    await expectMatchesLegacy(repo);

    const after = fs.statSync(indexPath, { bigint: true });
    expect([after.ino, after.mtimeNs, after.size]).toEqual([
      before.ino,
      before.mtimeNs,
      before.size,
    ]);
    expect(
      fs.existsSync(path.join(repo, '.git', 'elevenex', 'status-index')),
    ).toBe(true);
  });

  it('notices same-size edits made in the same second as the cached read', async () => {
    write(repo, 'tracked/a.txt', 'aaaa\n');
    git(repo, 'commit', '-q', '-am', 'four letters');
    await expectMatchesLegacy(repo);

    // Same size and, very likely, the same mtime second as the saved copy.
    write(repo, 'tracked/a.txt', 'bbbb\n');
    const read = await expectMatchesLegacy(repo);
    expect(read.status.modified).toEqual(['tracked/a.txt']);
  });

  it('reports conflicts and a detached HEAD like simple-git', async () => {
    git(repo, 'switch', '-q', '-c', 'side');
    write(repo, 'tracked/a.txt', 'side\n');
    git(repo, 'commit', '-q', '-am', 'side');
    git(repo, 'switch', '-q', 'main');
    write(repo, 'tracked/a.txt', 'main\n');
    git(repo, 'commit', '-q', '-am', 'main');
    try {
      git(repo, 'merge', '-q', 'side');
    } catch {
      /* Expected conflict. */
    }
    const conflicted = await expectMatchesLegacy(repo);
    expect(conflicted.status.conflicted).toEqual(['tracked/a.txt']);

    git(repo, 'merge', '--abort');
    git(repo, 'switch', '-q', '--detach', 'HEAD~1');
    write(repo, 'scratch/file.txt', 'scratch\n');
    const detached = await expectMatchesLegacy(repo);
    expect(detached.status.detached).toBe(true);
  });

  it('reports upstream tracking and ahead/behind counts', async () => {
    const remote = path.join(tmpDir, 'remote.git');
    git(tmpDir, 'init', '-q', '--bare', remote);
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    write(repo, 'tracked/a.txt', 'ahead\n');
    git(repo, 'commit', '-q', '-am', 'ahead');

    const read = await expectMatchesLegacy(repo);
    expect([read.status.tracking, read.status.ahead]).toEqual([
      'origin/main',
      1,
    ]);
  });

  it('reads from a subdirectory of the worktree', async () => {
    write(repo, 'newdir/x.txt', 'x\n');
    write(repo, 'tracked/a.txt', 'edited\n');
    await expectMatchesLegacy(path.join(repo, 'tracked'));
  });

  it('reuses a warm copy after the process restarts', async () => {
    write(repo, 'newdir/x.txt', 'x\n');
    await expectMatchesLegacy(repo);

    resetWorktreeStatusReader();
    // A cold copy would have to wait; the saved warm one must not.
    configureWorktreeStatusReader({ indexSettleMs: 60 * 60_000 });
    await expectMatchesLegacy(repo);
  });

  it('waits for a recently changed index before building the cache', async () => {
    configureWorktreeStatusReader({ indexSettleMs: 60 * 60_000 });
    write(repo, 'newdir/x.txt', 'x\n');
    const read = await expectMatchesLegacy(repo, 'full-scan');
    expect(read.fallbackReason).toMatch(/index changed recently/);
  });

  it('falls back to a full scan when the repository disables the untracked cache', async () => {
    git(repo, 'config', 'core.untrackedCache', 'false');
    write(repo, 'newdir/x.txt', 'x\n');
    await expectMatchesLegacy(repo, 'full-scan');
    expect(fs.existsSync(path.join(repo, '.git', 'elevenex'))).toBe(false);
  });

  it('falls back to a full scan for split indexes', async () => {
    git(repo, 'update-index', '--split-index');
    write(repo, 'newdir/x.txt', 'x\n');
    const read = await expectMatchesLegacy(repo, 'full-scan');
    expect(read.fallbackReason).toBe('split index');
  });

  it('handles repositories without commits or an index', async () => {
    const empty = path.join(tmpDir, 'empty');
    fs.mkdirSync(empty);
    git(empty, 'init', '-q', '-b', 'main');
    write(empty, 'dir/file.txt', 'file\n');
    const unborn = await expectMatchesLegacy(empty, 'full-scan');
    expect(unborn.fallbackReason).toBe('repository has no index yet');

    git(empty, 'add', 'dir/file.txt');
    write(empty, 'other/file.txt', 'other\n');
    await expectMatchesLegacy(empty);
  });
});

describe('tracked status helpers', () => {
  const status = (files: StatusResult['files']): StatusResult =>
    ({
      files,
      renamed: files
        .filter((file) => file.index === 'R')
        .map((file) => ({ from: file.from!, to: file.path })),
      conflicted: files
        .filter((file) => file.index === 'U' || file.working_dir === 'U')
        .map((file) => file.path),
    }) as unknown as StatusResult;

  it('lists tracked paths and rename sources, never untracked ones', () => {
    expect(
      trackedStatusPaths(
        status([
          { path: 'new.txt', from: 'old.txt', index: 'R', working_dir: ' ' },
          { path: 'edit.txt', index: ' ', working_dir: 'M' },
          { path: 'conflict.txt', index: 'U', working_dir: 'U' },
          { path: 'untracked.txt', index: '?', working_dir: '?' },
        ]),
      ).sort(),
    ).toEqual(['conflict.txt', 'edit.txt', 'new.txt', 'old.txt']);
  });

  it('tells which side of the index has changes', () => {
    const stagedOnly = status([
      { path: 'a', index: 'M', working_dir: ' ' },
      { path: 'b', index: '?', working_dir: '?' },
    ]);
    expect(hasTrackedChanges(stagedOnly, 'staged')).toBe(true);
    expect(hasTrackedChanges(stagedOnly, 'unstaged')).toBe(false);

    const unstagedOnly = status([{ path: 'a', index: ' ', working_dir: 'D' }]);
    expect(hasTrackedChanges(unstagedOnly, 'staged')).toBe(false);
    expect(hasTrackedChanges(unstagedOnly, 'unstaged')).toBe(true);

    const conflict = status([{ path: 'a', index: 'U', working_dir: 'U' }]);
    expect(hasTrackedChanges(conflict, 'staged')).toBe(true);
    expect(hasTrackedChanges(conflict, 'unstaged')).toBe(true);
  });
});
