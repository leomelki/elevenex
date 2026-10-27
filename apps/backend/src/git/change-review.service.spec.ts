import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import * as systemPaths from '../config/system-paths.js';
import { ChangeReviewService } from './change-review.service.js';
import { clearWorktreeFingerprintCache } from './git-worktree-fingerprint.js';

describe('ChangeReviewService', () => {
  // These integration tests create repositories and exercise thousands of paths.
  jest.setTimeout(30_000);
  let service: ChangeReviewService;
  let tmpDir: string;
  let repoPath: string;
  let externalCommands: jest.SpyInstance;

  // Expose only the internals needed to pause real builds at deterministic
  // boundaries; Git operations and the public review API still run normally.
  function internals() {
    return service as unknown as {
      execFileSafe: ChangeReviewService['execFileSafe'];
      readPullRequestInfo: ChangeReviewService['readPullRequestInfo'];
      refreshLikelyBase: ChangeReviewService['refreshLikelyBase'];
      detectBaseRef: ChangeReviewService['detectBaseRef'];
      readRefAgeSeconds: ChangeReviewService['readRefAgeSeconds'];
      buildFileSummaries: ChangeReviewService['buildFileSummaries'];
      buildRows: ChangeReviewService['buildRows'];
      buildDiffArgs: ChangeReviewService['buildDiffArgs'];
      readGitFile: ChangeReviewService['readGitFile'];
      baseCache: ChangeReviewService['baseCache'];
      summaryCache: ChangeReviewService['summaryCache'];
      fileCountCache: ChangeReviewService['fileCountCache'];
      rowCache: ChangeReviewService['rowCache'];
      fileLinesCache: ChangeReviewService['fileLinesCache'];
      contextWindowCache: ChangeReviewService['contextWindowCache'];
      baseBuilds: ChangeReviewService['baseBuilds'];
      rowBuilds: ChangeReviewService['rowBuilds'];
      fileLinesBuilds: ChangeReviewService['fileLinesBuilds'];
      contextWindowBuilds: ChangeReviewService['contextWindowBuilds'];
      getOrBuild: ChangeReviewService['getOrBuild'];
    };
  }

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function setupOrigin(): string {
    const remotePath = path.join(tmpDir, 'remote.git');
    fs.mkdirSync(remotePath);
    git('init --bare', remotePath);
    git(`remote add origin "${remotePath}"`);
    git('push -u origin main');
    git('symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main');
    return remotePath;
  }

  function commitTree(changes: string[]): void {
    const parent = git('rev-parse HEAD').trim();
    execFileSync('git', ['fast-import', '--quiet'], {
      cwd: repoPath,
      input: [
        'commit refs/heads/main',
        'committer Test User <test@test.com> 1700000000 +0000',
        'data 7',
        'fixture',
        `from ${parent}`,
        ...changes,
        '',
        '',
      ].join('\n'),
    });
  }

  function git(command: string, cwd = repoPath): string {
    return execSync(`git ${command}`, { cwd, encoding: 'utf8' });
  }

  function write(relativePath: string, contents: string): void {
    const target = path.join(repoPath, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ChangeReviewService],
    }).compile();

    service = module.get(ChangeReviewService);
    const execFileSafe = service['execFileSafe'].bind(service);
    externalCommands = jest
      .spyOn(internals(), 'execFileSafe')
      .mockImplementation((command, args, cwd, timeout) =>
        command === 'gh'
          ? Promise.resolve(null)
          : execFileSafe(command, args, cwd, timeout),
      );
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'change-review-'));
    repoPath = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoPath);
    git('init');
    git('config user.email "test@test.com"');
    git('config user.name "Test User"');
    write('README.md', 'one\n');
    git('add .');
    git('commit -m "initial"');
    git('branch -M main');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves row hash bytes and yields while hashing a large window', async () => {
    const rows = Array.from({ length: 1025 }, (_, index) => ({
      id: String(index),
      type: 'add' as const,
      oldLine: null,
      newLine: index + 1,
      content: `text 😃\0\n${index}`,
      path: 'tab\tline\nfile',
    }));
    let yielded = false;
    setImmediate(() => {
      yielded = true;
    });
    const hash = await service['hashRows'](rows);
    expect(yielded).toBe(true);
    // Existing per-field SHA-256 serialization, including Unicode and NULs.
    expect(hash).toBe(
      '598f9c1227533180857583f30608341f3dad73550f8ca5b9c08aa6e35ebe4718',
    );
  });

  it('summarizes staged, unstaged, and untracked changes', async () => {
    write('README.md', 'one\ntwo\n');
    write('src/new.ts', 'export const value = 1;\n');

    const summary = await service.getSummary(repoPath, 'uncommitted');

    expect(summary.compareLabel).toBe('Uncommitted changes');
    expect(summary.headSha).toMatch(/^[a-f0-9]{40}$/);
    expect(summary.worktreeFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(summary.files.map((file) => file.path)).toEqual([
      'README.md',
      'src/new.ts',
    ]);
    expect(summary.totals.files).toBe(2);
    expect(summary.totals.additions).toBeGreaterThanOrEqual(2);
  });

  it('excludes internal tracked-worktree changes from uncommitted reviews', async () => {
    const relativePath = '.worktrees/nested';
    const worktreePath = path.join(repoPath, relativePath);
    git(`worktree add -b nested "${worktreePath}"`);
    git(`add -- ${relativePath}`);
    git('commit -m "Track nested worktree"');
    write(`${relativePath}/README.md`, 'nested change\n');
    write(`${relativePath}/untracked.txt`, 'new\n');
    write('README.md', 'one\ntwo\n');

    const summary = await service.getSummary(repoPath, 'uncommitted');

    expect(summary.files.map((file) => file.path)).toEqual(['README.md']);
    expect(summary.totals).toEqual({ files: 1, additions: 1, deletions: 0 });
  });

  it('renders untracked symlink contents without following their targets', async () => {
    fs.symlinkSync('missing-target', path.join(repoPath, 'dangling'));
    const target = path.join(tmpDir, 'large-target');
    fs.writeFileSync(target, 'x'.repeat(1_000_001));
    fs.symlinkSync(target, path.join(repoPath, 'large-link'));

    const summary = await service.getSummary(repoPath, 'uncommitted');
    expect(summary.files.map((file) => file.path)).toEqual([
      'dangling',
      'large-link',
    ]);
    for (const [filePath, content] of [
      ['dangling', 'missing-target'],
      ['large-link', target],
    ]) {
      const window = await service.getFileWindow(
        repoPath,
        'uncommitted',
        filePath,
      );
      expect(window.large).toBe(false);
      expect(
        window.rows
          .filter((row) => row.type === 'add')
          .map((row) => row.content),
      ).toEqual([content]);
    }
  });

  it('refreshes gitlink windows on nested HEAD changes while ignoring nested dirtiness', async () => {
    const relativePath = '.worktrees/nested';
    const nested = path.join(repoPath, relativePath);
    git(`worktree add -b nested "${nested}"`);
    git(`add -- ${relativePath}`);
    git('commit -m "Track nested worktree"');
    const read = () =>
      service.getFileWindow(repoPath, 'uncommitted', relativePath);
    write(`${relativePath}/README.md`, 'nested commit one\n');
    git('commit -am "Nested one"', nested);
    const firstHead = git('rev-parse HEAD', nested).trim();
    const first = await read();
    expect(JSON.stringify(first.rows)).toContain(firstHead);
    const context = () =>
      service.getContextWindow(repoPath, 'uncommitted', relativePath, {
        oldStart: 1,
        newStart: 1,
        count: 1,
      });
    expect((await context()).rows[0].content).toBe(
      `Subproject commit ${firstHead}`,
    );
    const firstSummary = await service.getSummary(repoPath, 'uncommitted');

    write(`${relativePath}/README.md`, 'nested dirty contents\n');
    expect((await read()).rows).toEqual(first.rows);
    expect(
      (await service.getSummary(repoPath, 'uncommitted')).worktreeFingerprint,
    ).toBe(firstSummary.worktreeFingerprint);

    git('commit -am "Nested two"', nested);
    const secondHead = git('rev-parse HEAD', nested).trim();
    const second = await read();
    expect(JSON.stringify(second.rows)).toContain(secondHead);
    expect(second.rows).not.toEqual(first.rows);
    expect((await context()).rows[0].content).toBe(
      `Subproject commit ${secondHead}`,
    );
    expect(
      (await service.getSummary(repoPath, 'uncommitted')).worktreeFingerprint,
    ).not.toBe(firstSummary.worktreeFingerprint);
    git(`add -- ${relativePath}`);
    git('commit -m "Update gitlink"');
    const historical = await service.getFileWindow(
      repoPath,
      'last-commit',
      relativePath,
    );
    expect(JSON.stringify(historical.rows)).toContain(secondHead);
  });

  it('pauses large uncommitted change sets before loading file summaries or rows', async () => {
    for (let index = 0; index < 2_001; index += 1) {
      write(`bulk/file-${index}.txt`, '');
    }

    const summary = await service.getSummary(repoPath, 'uncommitted');

    expect(summary.loadGuard).toMatchObject({
      blocked: true,
      threshold: 2_000,
      totalFiles: 2_001,
      reason: 'worktree',
    });
    expect(summary.files).toEqual([]);
    expect(summary.totals).toEqual({
      files: 2_001,
      additions: 0,
      deletions: 0,
    });
    await expect(
      service.getFileWindow(repoPath, 'uncommitted', 'bulk/file-0.txt'),
    ).rejects.toThrow(/Diff loading is paused/);
  });

  it('updates the summary fingerprint when working tree content changes', async () => {
    write('README.md', 'one\ntwo\n');
    const before = await service.getSummary(repoPath, 'uncommitted');

    write('README.md', 'one\ntwo\nthree\n');
    const after = await service.getSummary(repoPath, 'uncommitted');

    expect(before.headSha).toBe(after.headSha);
    expect(before.worktreeFingerprint).not.toBe(after.worktreeFingerprint);
    expect(after.totals.additions).toBeGreaterThan(before.totals.additions);
  });

  it('reuses selected rows and content after unrelated edits and commits with bounded path validation', async () => {
    setupOrigin();
    git('checkout -b feature');
    write('README.md', 'one\nselected\n');
    for (let i = 0; i < 150; i++) write(`dirty-${i}.txt`, 'dirty\n');
    const rows = jest.spyOn(internals(), 'buildRows');
    const reads = jest.spyOn(internals(), 'readGitFile');
    const first = await service.getFileWindow(repoPath, 'branch', 'README.md');
    const stat = jest.spyOn(fs.promises, 'stat');
    const lstat = jest.spyOn(fs.promises, 'lstat');
    write('dirty-0.txt', 'other\n');
    const second = await service.getFileWindow(repoPath, 'branch', 'README.md');
    expect(second.rows).toEqual(first.rows);
    expect(rows).toHaveBeenCalledTimes(1);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(stat.mock.calls.length + lstat.mock.calls.length).toBeLessThan(20);
    expect(internals().rowCache.size).toBe(1);
    git('add dirty-0.txt');
    git('commit -m "unrelated"');
    const third = await service.getFileWindow(repoPath, 'branch', 'README.md');
    expect(third.changeHash).toBe(first.changeHash);
    expect(rows).toHaveBeenCalledTimes(1);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('discards obsolete row/content/context versions during repeated selected-file edits', async () => {
    for (let i = 0; i < 20; i++) {
      write('README.md', `one\nedit ${i}\n`);
      await service.getFileWindow(repoPath, 'uncommitted', 'README.md');
      await service.getContextWindow(repoPath, 'uncommitted', 'README.md', {
        oldStart: 1,
        newStart: 1,
        count: 1,
      });
      expect(internals().rowCache.size).toBe(1);
      expect(internals().fileLinesCache.size).toBe(1);
      expect(internals().contextWindowCache.size).toBe(1);
      expect(service.cacheDiagnostics().bytes).toBeLessThanOrEqual(
        service.cacheDiagnostics().maxBytes,
      );
    }
    service.releaseWorktree(repoPath);
    expect(internals().rowCache.size).toBe(0);
    expect(internals().fileLinesCache.size).toBe(0);
    expect(internals().contextWindowCache.size).toBe(0);
  });

  it('reuses immutable blobs between linked worktrees', async () => {
    setupOrigin();
    git('checkout -b feature');
    write('README.md', 'one\nfeature\n');
    git('commit -am "feature"');
    const reads = jest.spyOn(internals(), 'readGitFile');
    await service.getFileWindow(repoPath, 'branch', 'README.md');
    const linked = path.join(tmpDir, 'linked');
    git(`worktree add -b linked "${linked}"`);
    await service.getFileWindow(linked, 'branch', 'README.md');
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('detects same-size atomic edits, stage and unstage without reusing stale rows', async () => {
    write('README.md', 'one\nAAA\n');
    const before = await service.getFileWindow(
      repoPath,
      'uncommitted',
      'README.md',
    );
    write('replacement', 'one\nBBB\n');
    fs.renameSync(
      path.join(repoPath, 'replacement'),
      path.join(repoPath, 'README.md'),
    );
    const edited = await service.getFileWindow(
      repoPath,
      'uncommitted',
      'README.md',
    );
    expect(edited.changeHash).not.toBe(before.changeHash);
    expect(edited.fingerprint).not.toBe(before.fingerprint);
    git('add README.md');
    expect(
      (await service.getFileWindow(repoPath, 'uncommitted', 'README.md'))
        .changeHash,
    ).toBe(edited.changeHash);
    git('reset HEAD -- README.md');
    expect(
      (await service.getFileWindow(repoPath, 'uncommitted', 'README.md'))
        .changeHash,
    ).toBe(edited.changeHash);
  });

  it('keeps net branch semantics when worktree edits undo committed changes', async () => {
    setupOrigin();
    git('checkout -b feature');
    write('README.md', 'committed change\n');
    git('commit -am "feature"');
    await service.getFileWindow(repoPath, 'branch', 'README.md');
    write('README.md', 'one\n');
    clearWorktreeFingerprintCache(repoPath);
    const summary = await service.getSummary(repoPath, 'branch');
    expect(summary.files).toEqual([]);
    await expect(
      service.getFileWindow(repoPath, 'branch', 'README.md'),
    ).rejects.toThrow(/not changed/);
  });

  it.each(['branch', 'uncommitted'] as const)(
    'compares restored untracked deletions to final content in %s scope',
    async (scope) => {
      setupOrigin();
      if (scope === 'branch') git('checkout -b feature');
      git('rm README.md');
      if (scope === 'branch') git('commit -m "delete"');
      const index = fs.readFileSync(path.join(repoPath, '.git/index'));
      write('README.md', 'one\n');
      expect((await service.getSummary(repoPath, scope)).files).toEqual([]);
      write('README.md', 'changed\n');
      const summary = await service.getSummary(repoPath, scope);
      expect(summary.files).toEqual([
        expect.objectContaining({
          path: 'README.md',
          status: 'modified',
          additions: 1,
          deletions: 1,
        }),
      ]);
      const window = await service.getFileWindow(repoPath, scope, 'README.md');
      expect(window.rows.some((row) => row.content === 'changed')).toBe(true);
      expect(fs.readFileSync(path.join(repoPath, '.git/index'))).toEqual(index);
    },
  );

  it('updates both rename endpoints when an old path is restored as untracked', async () => {
    setupOrigin();
    git('checkout -b feature');
    git('mv README.md next.md');
    git('commit -m "rename"');
    await service.getFileWindow(repoPath, 'branch', 'next.md');
    write('README.md', 'one\n');
    clearWorktreeFingerprintCache(repoPath);
    const restored = await service.getFileWindow(repoPath, 'branch', 'next.md');
    expect(restored.status).toBe('added');
    expect((await service.getSummary(repoPath, 'branch')).files).toEqual([
      expect.objectContaining({
        path: 'next.md',
        status: 'added',
        oldPath: null,
      }),
    ]);
    fs.unlinkSync(path.join(repoPath, 'README.md'));
    expect(
      (await service.getFileWindow(repoPath, 'branch', 'next.md')).status,
    ).toBe('renamed');
  });

  it('does not guard a large net-unchanged set of restored untracked paths', async () => {
    for (let i = 0; i < 1001; i++) write(`restored-${i}.txt`, 'original\n');
    git('add .');
    git('commit -m "sources"');
    setupOrigin();
    git('checkout -b feature');
    execFileSync(
      'git',
      [
        'rm',
        '--',
        ...Array.from({ length: 1001 }, (_, i) => `restored-${i}.txt`),
      ],
      { cwd: repoPath },
    );
    git('commit -m "delete sources"');
    for (let i = 0; i < 1001; i++) write(`restored-${i}.txt`, 'original\n');
    const summary = await service.getSummary(repoPath, 'branch');
    expect(summary.loadGuard).toBeNull();
    expect(summary.files).toEqual([]);
  });

  it('preserves case-only renames when validating changed modes', async () => {
    if (process.platform === 'win32') return;
    setupOrigin();
    git('checkout -b feature');
    git('mv README.md readme.md');
    git('commit -m "rename case"');
    await service.getFileWindow(repoPath, 'branch', 'readme.md');
    fs.chmodSync(path.join(repoPath, 'readme.md'), 0o755);
    expect(
      (await service.getFileWindow(repoPath, 'branch', 'readme.md')).status,
    ).toBe('renamed');
  });

  it('handles restored NUL-framed paths with a split index and releases temporary state', async () => {
    const name = 'restored\twith\nlines.txt';
    write(name, 'original\n');
    git('add .');
    git('commit -m "source"');
    setupOrigin();
    git('checkout -b feature');
    git('config core.splitIndex true');
    git('update-index --split-index');
    execFileSync('git', ['rm', '--', name], { cwd: repoPath });
    git('commit -m "delete source"');
    write(name, 'changed\n');
    const indexPath = path.join(repoPath, '.git/index');
    const before = fs.readFileSync(indexPath);
    const shared = fs
      .readdirSync(path.join(repoPath, '.git'))
      .filter((file) => file.startsWith('sharedindex.'))
      .sort();
    const temporaryDirectories = jest.spyOn(fs.promises, 'mkdtemp');
    const window = await service.getFileWindow(repoPath, 'branch', name);
    expect(window.status).toBe('modified');
    expect(window.rows.some((row) => row.content === 'changed')).toBe(true);
    expect(fs.readFileSync(indexPath)).toEqual(before);
    expect(
      fs
        .readdirSync(path.join(repoPath, '.git'))
        .filter((file) => file.startsWith('sharedindex.'))
        .sort(),
    ).toEqual(shared);
    const created = await Promise.all(
      temporaryDirectories.mock.results
        .filter((result) => result.type === 'return')
        .map((result) => result.value as Promise<string>),
    );
    expect(created.length).toBeGreaterThan(0);
    for (const directory of created)
      expect(fs.existsSync(directory)).toBe(false);
  });

  it('discovers new paths by the scan deadline during continuous summary requests', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    await service.getSummary(repoPath, 'uncommitted');
    write('new.txt', 'new\n');
    for (const time of [1_500, 2_000]) {
      now.mockReturnValue(time);
      await service.getSummary(repoPath, 'uncommitted');
    }
    now.mockReturnValue(2_500);
    const summary = await service.getSummary(repoPath, 'uncommitted');
    expect(summary.files.map((file) => file.path)).toEqual(['new.txt']);
  });

  it('parses real rename numstats and NUL-safe paths containing tabs and newlines', async () => {
    const old = 'old\tname\n.txt',
      next = 'new\tname\n.txt';
    write(old, 'rename\n'.repeat(30));
    git('add .');
    git('commit -m "path"');
    fs.renameSync(path.join(repoPath, old), path.join(repoPath, next));
    fs.appendFileSync(path.join(repoPath, next), 'extra\n');
    git('add -A');
    const summary = await service.getSummary(repoPath, 'uncommitted');
    expect(summary.files).toEqual([
      expect.objectContaining({
        path: next,
        oldPath: old,
        status: 'renamed',
        additions: 1,
        deletions: 0,
      }),
    ]);
    const window = await service.getFileWindow(repoPath, 'uncommitted', next);
    expect(window.rows.some((row) => row.content === 'extra')).toBe(true);
  });

  it('supports an unborn HEAD and compares merge commits to their first parent', async () => {
    const unborn = path.join(tmpDir, 'unborn');
    fs.mkdirSync(unborn);
    git('init -b fresh', unborn);
    fs.writeFileSync(path.join(unborn, 'first.txt'), 'first\n');
    git('add .', unborn);
    const initial = await service.getSummary(unborn, 'uncommitted');
    expect(initial.headSha).toBeNull();
    expect(initial.branch).toBe('fresh');
    expect(
      (
        await service.getFileWindow(unborn, 'uncommitted', 'first.txt')
      ).rows.some((row) => row.content === 'first'),
    ).toBe(true);
    git('checkout -b side');
    write('side.txt', 'side\n');
    git('add .');
    git('commit -m "side"');
    git('checkout main');
    write('main.txt', 'main\n');
    git('add .');
    git('commit -m "main"');
    git('merge --no-ff side -m "merge"');
    const merge = await service.getSummary(repoPath, 'last-commit');
    expect(merge.files.map((file) => file.path)).toEqual(['side.txt']);
    expect(
      (
        await service.getFileWindow(repoPath, 'last-commit', 'side.txt')
      ).rows.some((row) => row.content === 'side'),
    ).toBe(true);
  });

  it('guards large historical blobs and caps forced output without stack overflow', async () => {
    write('README.md', 'large\n'.repeat(180_000));
    git('commit -am "large historical file"');
    write('README.md', 'small\n');
    const guarded = await service.getFileWindow(
      repoPath,
      'uncommitted',
      'README.md',
    );
    expect(guarded.large).toBe(true);
    expect(guarded.truncated).toBe(true);
    const forced = await service.getFileWindow(
      repoPath,
      'uncommitted',
      'README.md',
      { forceFileLoad: true },
    );
    expect(forced.totalRows).toBeLessThanOrEqual(50_000);
    expect(forced.truncated).toBe(true);
    write('README.md', 'x'.repeat(9 * 1024 * 1024));
    const oversized = await service.getFileWindow(
      repoPath,
      'uncommitted',
      'README.md',
      { forceFileLoad: true },
    );
    expect(oversized.truncated).toBe(true);
    expect(oversized.message).toMatch(/byte.*limit/);
  });

  it('bounds synthesized full-file rows for a forced mode-only change', async () => {
    if (process.platform === 'win32') return;
    write('README.md', 'context\n'.repeat(50_001));
    git('commit -am "long context"');
    fs.chmodSync(path.join(repoPath, 'README.md'), 0o755);
    const window = await service.getFileWindow(
      repoPath,
      'uncommitted',
      'README.md',
      { fullFile: true, forceFileLoad: true },
    );
    expect(window.totalRows).toBeLessThanOrEqual(50_000);
    expect(window.truncated).toBe(true);
  });

  it('updates viewed fingerprints when worktree file content changes without loading diff rows', async () => {
    write('README.md', 'one\ntwo\n');
    const before = await service.getFileFingerprints(repoPath, 'uncommitted', [
      'README.md',
    ]);

    write('README.md', 'one\ntwo\nthree\n');
    const after = await service.getFileFingerprints(repoPath, 'uncommitted', [
      'README.md',
    ]);

    expect(before.fingerprints[0].fingerprint).toMatch(/^cr-viewed-fp-v1:/);
    expect(before.fingerprints[0].fingerprint).not.toBe(
      after.fingerprints[0].fingerprint,
    );
  });

  it('returns stable viewed fingerprints for untracked, binary, renamed, and deleted files', async () => {
    write('delete-me.txt', 'delete me\n');
    git('add .');
    git('commit -m "add delete target"');
    git('mv README.md RENAMED.md');
    fs.unlinkSync(path.join(repoPath, 'delete-me.txt'));
    fs.writeFileSync(path.join(repoPath, 'binary.dat'), Buffer.from([0, 1, 2]));

    const first = await service.getFileFingerprints(repoPath, 'uncommitted', [
      'RENAMED.md',
      'delete-me.txt',
      'binary.dat',
    ]);
    const second = await service.getFileFingerprints(repoPath, 'uncommitted', [
      'RENAMED.md',
      'delete-me.txt',
      'binary.dat',
    ]);

    expect(first.fingerprints).toEqual(second.fingerprints);
    expect(first.fingerprints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'RENAMED.md',
          oldPath: 'README.md',
          status: 'renamed',
          fingerprint: expect.stringMatching(/^cr-viewed-fp-v1:renamed:/),
        }),
        expect.objectContaining({
          path: 'delete-me.txt',
          status: 'deleted',
          fingerprint: expect.stringContaining('git-blob:'),
        }),
        expect.objectContaining({
          path: 'binary.dat',
          status: 'added',
          fingerprint: expect.stringContaining('xxh3-64:'),
        }),
      ]),
    );
  });

  it('rejects viewed fingerprints for paths outside the requested scope', async () => {
    await expect(
      service.getFileFingerprints(repoPath, 'uncommitted', ['missing.ts']),
    ).rejects.toThrow(/File is not changed in this scope/);
  });

  it('fingerprints large files without loading their diff rows', async () => {
    write('README.md', 'x'.repeat(1_000_001));

    const response = await service.getFileFingerprints(
      repoPath,
      'uncommitted',
      ['README.md'],
    );

    expect(response.fingerprints[0]).toMatchObject({
      path: 'README.md',
      fingerprint: expect.stringContaining('xxh3-64:'),
    });
  });

  it('loads a windowed textual diff for a changed file', async () => {
    write(
      'README.md',
      Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n'),
    );

    const first = await service.getFileWindow(
      repoPath,
      'uncommitted',
      'README.md',
      {
        offset: 0,
        limit: 5,
        context: 2,
      },
    );
    const second = await service.getFileWindow(
      repoPath,
      'uncommitted',
      'README.md',
      {
        offset: 5,
        limit: 5,
        context: 2,
      },
    );

    expect(first.totalRows).toBeGreaterThan(5);
    expect(first.rows).toHaveLength(5);
    expect(second.rows[0].id).not.toBe(first.rows[0].id);
  });

  it('collapses similar delete/add pairs into modified rows', async () => {
    write('src/app.ts', 'const value = 1;\n');
    git('add .');
    git('commit -m "add app"');
    write('src/app.ts', 'const value = 2;\n');

    const fileWindow = await service.getFileWindow(
      repoPath,
      'uncommitted',
      'src/app.ts',
      {
        offset: 0,
        limit: 20,
        context: 0,
      },
    );

    const changed = fileWindow.rows.find((row) => row.type === 'change');
    expect(changed).toMatchObject({
      oldLine: 1,
      newLine: 1,
      oldContent: 'const value = 1;',
      content: 'const value = 2;',
    });
    expect(fileWindow.rows.some((row) => row.type === 'delete')).toBe(false);
    expect(fileWindow.rows.some((row) => row.type === 'add')).toBe(false);
  });

  describe('full-file rendering', () => {
    function writeNumberedFile(relativePath: string, lineCount: number): void {
      const lines = Array.from(
        { length: lineCount },
        (_unused, index) => `line ${index + 1}`,
      );
      write(relativePath, `${lines.join('\n')}\n`);
    }

    /**
     * The invariant full-file mode promises: every line of the new file is
     * present exactly once. Asserting this rather than a raw row count keeps
     * the test honest about *what matters* while staying immune to whether a
     * given edit collapses into one `change` row or a `delete`/`add` pair.
     */
    function renderedNewLines(rows: readonly { newLine: number | null }[]) {
      return rows
        .map((row) => row.newLine)
        .filter((line): line is number => line !== null);
    }

    it('returns every line of a modified file and leaves no expandable gaps', async () => {
      writeNumberedFile('src/big.ts', 300);
      git('add .');
      git('commit -m "add big"');
      write(
        'src/big.ts',
        fs
          .readFileSync(path.join(repoPath, 'src/big.ts'), 'utf8')
          .replace('line 150', 'line 150 changed'),
      );

      const fileWindow = await service.getFileWindow(
        repoPath,
        'uncommitted',
        'src/big.ts',
        { offset: 0, limit: 1_000, fullFile: true },
      );

      expect(fileWindow.fullFile).toBe(true);
      expect(renderedNewLines(fileWindow.rows)).toEqual(
        Array.from({ length: 300 }, (_unused, index) => index + 1),
      );
      expect(fileWindow.contextRanges).toEqual([]);
      expect(
        fileWindow.rows.some((row) => row.content === 'line 150 changed'),
      ).toBe(true);
    });

    it('shows only nearby context when full-file mode is off', async () => {
      writeNumberedFile('src/big.ts', 300);
      git('add .');
      git('commit -m "add big"');
      write(
        'src/big.ts',
        fs
          .readFileSync(path.join(repoPath, 'src/big.ts'), 'utf8')
          .replace('line 150', 'line 150 changed'),
      );

      const fileWindow = await service.getFileWindow(
        repoPath,
        'uncommitted',
        'src/big.ts',
        { offset: 0, limit: 1_000, context: 3 },
      );

      expect(fileWindow.fullFile).toBe(false);
      expect(fileWindow.totalRows).toBeLessThan(30);
      expect(fileWindow.contextRanges.length).toBeGreaterThan(0);
    });

    it('renders whole files for the last-commit scope, which uses diff-tree', async () => {
      writeNumberedFile('src/big.ts', 120);
      git('add .');
      git('commit -m "add big"');
      write(
        'src/big.ts',
        fs
          .readFileSync(path.join(repoPath, 'src/big.ts'), 'utf8')
          .replace('line 60', 'line 60 changed'),
      );
      git('add .');
      git('commit -m "tweak big"');

      const fileWindow = await service.getFileWindow(
        repoPath,
        'last-commit',
        'src/big.ts',
        { offset: 0, limit: 1_000, fullFile: true },
      );

      expect(renderedNewLines(fileWindow.rows)).toEqual(
        Array.from({ length: 120 }, (_unused, index) => index + 1),
      );
      expect(fileWindow.contextRanges).toEqual([]);
    });

    it('renders whole files for the branch scope', async () => {
      const remotePath = path.join(tmpDir, 'remote.git');
      fs.mkdirSync(remotePath);
      git('init --bare', remotePath);
      git(`remote add origin ${remotePath}`);
      git('push -u origin main');
      git('symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main');
      git('checkout -b feature');
      writeNumberedFile('src/big.ts', 90);
      git('add .');
      git('commit -m "add big on feature"');

      const fileWindow = await service.getFileWindow(
        repoPath,
        'branch',
        'src/big.ts',
        { offset: 0, limit: 1_000, fullFile: true },
      );

      expect(renderedNewLines(fileWindow.rows)).toEqual(
        Array.from({ length: 90 }, (_unused, index) => index + 1),
      );
      expect(fileWindow.contextRanges).toEqual([]);
    });

    it('falls back to wide context when a full-file request is too large', async () => {
      writeNumberedFile('src/huge.ts', 9_000);
      git('add .');
      git('commit -m "add huge"');
      write(
        'src/huge.ts',
        fs
          .readFileSync(path.join(repoPath, 'src/huge.ts'), 'utf8')
          .replace('line 4500', 'line 4500 changed'),
      );

      const fileWindow = await service.getFileWindow(
        repoPath,
        'uncommitted',
        'src/huge.ts',
        { offset: 0, limit: 1_500, fullFile: true },
      );

      expect(fileWindow.truncated).toBe(true);
      expect(fileWindow.message).toMatch(/capped/i);
      expect(fileWindow.totalRows).toBeLessThan(9_000);
    });

    it('shows the whole file for a metadata-only change instead of a no-diff placeholder', async () => {
      // A mode change produces a patch with no hunks at all. The hunk view
      // rightly shows "no textual diff", but that reads as a failure when the
      // user explicitly asked to see the whole file.
      writeNumberedFile('src/tool.sh', 40);
      git('add .');
      git('commit -m "add tool"');
      fs.chmodSync(path.join(repoPath, 'src/tool.sh'), 0o755);

      const fileWindow = await service.getFileWindow(
        repoPath,
        'uncommitted',
        'src/tool.sh',
        { offset: 0, limit: 1_000, fullFile: true },
      );

      expect(fileWindow.rows.some((row) => row.type === 'meta')).toBe(false);
      expect(renderedNewLines(fileWindow.rows)).toEqual(
        Array.from({ length: 40 }, (_unused, index) => index + 1),
      );
      expect(fileWindow.rows[0]).toMatchObject({
        type: 'context',
        content: 'line 1',
      });
    });

    it('leaves the hunk view showing only patch metadata for a mode change', async () => {
      writeNumberedFile('src/tool.sh', 40);
      git('add .');
      git('commit -m "add tool"');
      fs.chmodSync(path.join(repoPath, 'src/tool.sh'), 0o755);

      const fileWindow = await service.getFileWindow(
        repoPath,
        'uncommitted',
        'src/tool.sh',
        { offset: 0, limit: 1_000 },
      );

      // Unchanged pre-existing behaviour: no hunks means no file content.
      expect(renderedNewLines(fileWindow.rows)).toEqual([]);
      expect(fileWindow.rows.map((row) => row.content)).toEqual(
        expect.arrayContaining(['old mode 100644', 'new mode 100755']),
      );
    });
  });

  describe('opening files with no diff', () => {
    it('serves an unchanged file as context rows when allowUnchanged is set', async () => {
      write('src/untouched.ts', 'export const a = 1;\nexport const b = 2;\n');
      git('add .');
      git('commit -m "add untouched"');

      const fileWindow = await service.getFileWindow(
        repoPath,
        'uncommitted',
        'src/untouched.ts',
        { offset: 0, limit: 100, allowUnchanged: true },
      );

      expect(fileWindow.unchanged).toBe(true);
      expect(fileWindow.status).toBe('modified');
      expect(fileWindow.totalRows).toBe(2);
      expect(fileWindow.rows).toEqual([
        expect.objectContaining({
          type: 'context',
          oldLine: 1,
          newLine: 1,
          content: 'export const a = 1;',
        }),
        expect.objectContaining({
          type: 'context',
          oldLine: 2,
          newLine: 2,
          content: 'export const b = 2;',
        }),
      ]);
      expect(fileWindow.fingerprint).toBeTruthy();
    });

    it('still rejects an unchanged file without the flag', async () => {
      write('src/untouched.ts', 'export const a = 1;\n');
      git('add .');
      git('commit -m "add untouched"');

      await expect(
        service.getFileWindow(repoPath, 'uncommitted', 'src/untouched.ts'),
      ).rejects.toThrow(/not changed in this scope/i);
    });

    it('rejects a path that does not exist in the worktree', async () => {
      await expect(
        service.getFileWindow(repoPath, 'uncommitted', 'src/missing.ts', {
          allowUnchanged: true,
        }),
      ).rejects.toThrow(/not found in worktree/i);
    });

    it('paginates an unchanged file through offset and limit', async () => {
      write(
        'src/untouched.ts',
        `${Array.from({ length: 10 }, (_u, i) => `line ${i + 1}`).join('\n')}\n`,
      );
      git('add .');
      git('commit -m "add untouched"');

      const second = await service.getFileWindow(
        repoPath,
        'uncommitted',
        'src/untouched.ts',
        { offset: 4, limit: 3, allowUnchanged: true },
      );

      expect(second.totalRows).toBe(10);
      expect(second.hasMore).toBe(true);
      expect(second.rows.map((row) => row.content)).toEqual([
        'line 5',
        'line 6',
        'line 7',
      ]);
      // Fingerprints are only computed for the first window.
      expect(second.fingerprint).toBeNull();
    });
  });

  it('keeps unrelated delete/add pairs split', async () => {
    write('README.md', 'zzzzzzzzzzzzzzzz\n');

    const fileWindow = await service.getFileWindow(
      repoPath,
      'uncommitted',
      'README.md',
      {
        offset: 0,
        limit: 20,
        context: 0,
      },
    );

    expect(fileWindow.rows.some((row) => row.type === 'change')).toBe(false);
    expect(fileWindow.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'delete', content: 'one' }),
        expect.objectContaining({ type: 'add', content: 'zzzzzzzzzzzzzzzz' }),
      ]),
    );
  });

  it('omits very large file diffs by default and loads them when forced', async () => {
    write(
      'README.md',
      Array.from({ length: 25_005 }, (_, index) => `line ${index}`).join('\n'),
    );

    const guarded = await service.getFileWindow(
      repoPath,
      'uncommitted',
      'README.md',
      {
        offset: 0,
        limit: 5,
        context: 0,
      },
    );

    expect(guarded.large).toBe(true);
    expect(guarded.rows).toEqual([
      expect.objectContaining({
        type: 'meta',
        content: 'Large file diff is hidden by default.',
      }),
    ]);

    const forced = await service.getFileWindow(
      repoPath,
      'uncommitted',
      'README.md',
      {
        offset: 0,
        limit: 5,
        context: 0,
        forceFileLoad: true,
      },
    );

    expect(forced.rows.some((row) => row.type === 'add')).toBe(true);
    expect(forced.message).toBeNull();
  });

  it('exposes expandable unchanged ranges before and after hunks without reloading the file window', async () => {
    write(
      'README.md',
      Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n'),
    );
    git('add README.md');
    git('commit -m "long readme"');
    write(
      'README.md',
      Array.from({ length: 60 }, (_, index) =>
        index === 29 ? 'line 30 changed' : `line ${index + 1}`,
      ).join('\n'),
    );

    const fileWindow = await service.getFileWindow(
      repoPath,
      'uncommitted',
      'README.md',
      {
        offset: 0,
        limit: 200,
        context: 2,
      },
    );
    const expandRows = fileWindow.rows.filter((row) => row.type === 'expand');

    expect(expandRows.length).toBeGreaterThanOrEqual(2);
    expect(expandRows[0].oldStart).toBe(1);
    expect(expandRows[0].newStart).toBe(1);

    const contextWindow = await service.getContextWindow(
      repoPath,
      'uncommitted',
      'README.md',
      {
        oldStart: expandRows[0].oldStart!,
        newStart: expandRows[0].newStart!,
        count: expandRows[0].count!,
        limit: 5,
      },
    );

    expect(contextWindow.rows).toHaveLength(5);
    expect(contextWindow.rows[0]).toMatchObject({
      type: 'context',
      oldLine: 1,
      newLine: 1,
      content: 'line 1',
    });
  });

  it('summarizes only HEAD for last-commit scope', async () => {
    write('committed.txt', 'committed\n');
    git('add committed.txt');
    git('commit -m "add committed"');
    write('uncommitted.txt', 'uncommitted\n');

    const summary = await service.getSummary(repoPath, 'last-commit');

    expect(summary.compareLabel).toBe('Last commit');
    expect(summary.files.map((file) => file.path)).toEqual(['committed.txt']);
  });

  it('detects origin HEAD for branch scope and includes local edits', async () => {
    const remotePath = path.join(tmpDir, 'remote.git');
    fs.mkdirSync(remotePath);
    git('init --bare', remotePath);
    git(`remote add origin ${remotePath}`);
    git('push -u origin main');
    git('symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main');
    git('checkout -b feature');
    write('feature.txt', 'committed\n');
    git('add feature.txt');
    git('commit -m "feature commit"');
    write('README.md', 'one\nlocal\n');

    const summary = await service.getSummary(repoPath, 'branch');

    expect(summary.baseRef).toBe('origin/main');
    expect(summary.mergeBaseSha).toBeTruthy();
    expect(summary.files.map((file) => file.path).sort()).toEqual([
      'README.md',
      'feature.txt',
    ]);
  });

  it.each(['uncommitted', 'last-commit'] as const)(
    'avoids gh, fetching, and branch enumeration for %s, including refresh',
    async (scope) => {
      const makeGit = systemPaths.worktreeSimpleGit;
      const branchLocal = jest
        .fn()
        .mockRejectedValue(new Error('enumerated branches'));
      jest
        .spyOn(systemPaths, 'worktreeSimpleGit')
        .mockImplementation((...args) => {
          const instance = makeGit(...args);
          instance.branchLocal = branchLocal;
          return instance;
        });
      await service.getSummary(repoPath, scope);
      await service.getSummary(repoPath, scope, true);
      await service.getFileWindow(repoPath, scope, 'README.md', {
        allowUnchanged: true,
      });
      expect(externalCommands).not.toHaveBeenCalled();
      expect(branchLocal).not.toHaveBeenCalled();
    },
  );

  it('updates last-commit summaries, rows, context, and fingerprints after a commit', async () => {
    write('README.md', 'one\ntwo\n');
    git('commit -am "second"');
    const before = await service.getSummary(repoPath, 'last-commit');
    const beforeRows = await service.getFileWindow(
      repoPath,
      'last-commit',
      'README.md',
    );
    const beforeFingerprints = await service.getFileFingerprints(
      repoPath,
      'last-commit',
      ['README.md'],
    );
    const range = { oldStart: 1, newStart: 1, count: 2 };
    await service.getContextWindow(repoPath, 'last-commit', 'README.md', range);

    write('README.md', 'one\nthree\n');
    write('new.txt', 'new\n');
    git('add .');
    git('commit -m "third"');
    const after = await service.getSummary(repoPath, 'last-commit');
    const afterRows = await service.getFileWindow(
      repoPath,
      'last-commit',
      'README.md',
    );
    const afterFingerprints = await service.getFileFingerprints(
      repoPath,
      'last-commit',
      ['README.md'],
    );
    const afterContext = await service.getContextWindow(
      repoPath,
      'last-commit',
      'README.md',
      range,
    );

    expect(after.headSha).toBe(git('rev-parse HEAD').trim());
    expect(after.baseSha).toBe(before.headSha);
    expect(after.files.map((file) => file.path)).toEqual([
      'new.txt',
      'README.md',
    ]);
    expect(afterRows.changeHash).not.toBe(beforeRows.changeHash);
    expect(afterRows.rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: 'three' })]),
    );
    expect(afterFingerprints.fingerprints).not.toEqual(
      beforeFingerprints.fingerprints,
    );
    expect(afterContext.rows[1].content).toBe('three');
  });

  it('updates uncommitted bases after a commit and branch switches at the same SHA', async () => {
    write('README.md', 'one\ntwo\n');
    const before = await service.getSummary(repoPath, 'uncommitted');
    git('commit -am "second"');
    const committed = await service.getSummary(repoPath, 'uncommitted');
    expect(committed.headSha).not.toBe(before.headSha);
    expect(committed.baseSha).toBe(committed.headSha);
    expect(committed.mergeBaseSha).toBe(committed.headSha);
    expect(committed.files).toEqual([]);

    git('checkout -b same-head');
    expect((await service.getSummary(repoPath, 'uncommitted')).branch).toBe(
      'same-head',
    );
    expect((await service.getSummary(repoPath, 'last-commit')).branch).toBe(
      'same-head',
    );
    git('checkout --detach');
    expect((await service.getSummary(repoPath, 'uncommitted')).branch).toBe(
      'HEAD',
    );
    expect((await service.getSummary(repoPath, 'last-commit')).branch).toBe(
      'HEAD',
    );
  });

  it('does not retain newly committed untracked paths in uncommitted reviews', async () => {
    write('new.txt', 'new\n');
    const before = await service.getSummary(repoPath, 'uncommitted');
    expect(before.files.map((file) => file.path)).toEqual(['new.txt']);
    git('add .');
    git('commit -m "commit formerly untracked path"');
    const after = await service.getSummary(repoPath, 'uncommitted');
    expect(after.headSha).not.toBe(before.headSha);
    expect(after.files).toEqual([]);
  });

  it('observes fetched base movement and branch switches without fetching or requerying gh on each read', async () => {
    const remote = setupOrigin();
    git('checkout -b feature');
    write('first.txt', 'first\n');
    git('add .');
    git('commit -m "first feature"');
    const firstFeature = git('rev-parse HEAD').trim();
    write('second.txt', 'second\n');
    git('add .');
    git('commit -m "second feature"');
    git('push origin feature');
    const before = await service.getSummary(repoPath, 'branch');

    // Move the actual remote independently, then fetch its tracking ref locally.
    git(`update-ref refs/heads/main ${firstFeature}`, remote);
    git('fetch origin main');
    const after = await service.getSummary(repoPath, 'branch');
    expect(after.headSha).toBe(before.headSha);
    expect(after.baseSha).toBe(firstFeature);
    expect(after.mergeBaseSha).toBe(firstFeature);
    expect(after.mergeBaseSha).not.toBe(before.mergeBaseSha);
    expect(after.files.map((file) => file.path)).toEqual(['second.txt']);
    expect(externalCommands.mock.calls.map(([command]) => command)).toEqual([
      'gh',
    ]);

    git('checkout -b same-head');
    const switched = await service.getSummary(repoPath, 'branch');
    expect(switched.headSha).toBe(after.headSha);
    expect(switched.branch).toBe('same-head');
    expect(switched.compareLabel).toBe('same-head vs origin/main');
    git('checkout main');
    expect((await service.getSummary(repoPath, 'branch')).headSha).toBe(
      git('rev-parse main').trim(),
    );
  });

  it('detects a locally fetched base that did not exist on the previous read', async () => {
    const before = await service.getSummary(repoPath, 'branch');
    expect(before.baseRef).toBeNull();
    setupOrigin();
    const after = await service.getSummary(repoPath, 'branch');
    expect(after.baseRef).toBe('origin/main');
    expect(after.baseSha).toBe(before.headSha);
    expect(after.mergeBaseSha).toBe(before.headSha);
    expect(externalCommands.mock.calls.map(([command]) => command)).toEqual([
      'gh',
    ]);
  });

  it('coalesces concurrent base, guard, summary, and row builds and caches metadata across commits', async () => {
    setupOrigin();
    git('checkout -b feature');
    write('README.md', 'one\nfeature\n');
    git('commit -am "feature"');
    const detect = jest.spyOn(internals(), 'detectBaseRef');
    const age = jest.spyOn(internals(), 'readRefAgeSeconds');
    const summaries = jest.spyOn(internals(), 'buildFileSummaries');
    const rows = jest.spyOn(internals(), 'buildRows');
    const diffArgs = jest.spyOn(internals(), 'buildDiffArgs');
    await Promise.all([
      ...Array.from({ length: 6 }, () =>
        service.getSummary(repoPath, 'branch'),
      ),
      ...Array.from({ length: 6 }, () =>
        service.getFileWindow(repoPath, 'branch', 'README.md'),
      ),
    ]);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(age).toHaveBeenCalledTimes(1);
    expect(summaries).toHaveBeenCalledTimes(1);
    expect(rows).toHaveBeenCalledTimes(1);
    // The candidate-path upper bound is under the limit, so the guard needs
    // no counting diff at all.
    expect(
      diffArgs.mock.calls.filter(
        ([, , flags]) =>
          flags.includes('--name-only') ||
          (flags.includes('--raw') && !flags.includes('--numstat')),
      ),
    ).toHaveLength(0);
    expect(
      diffArgs.mock.calls.some(([, , flags]) => flags.includes('--shortstat')),
    ).toBe(false);
    await service.getSummary(repoPath, 'branch');
    expect(age).toHaveBeenCalledTimes(1);
    expect(summaries).toHaveBeenCalledTimes(1);
    write('README.md', 'one\nfeature\nnew commit\n');
    git('commit -am "next"');
    expect(
      (await service.getSummary(repoPath, 'branch')).totals.additions,
    ).toBe(2);
    expect(externalCommands.mock.calls.map(([command]) => command)).toEqual([
      'gh',
    ]);
  });

  it('keeps refresh builds registered and rejects old cache publications after an older base finishes', async () => {
    setupOrigin();
    git('checkout -b feature');
    const oldHead = git('rev-parse HEAD').trim();
    const oldEntered = deferred();
    const newEntered = deferred();
    const releaseOld = deferred();
    const releaseNew = deferred();
    const metadata = jest
      .spyOn(internals(), 'readPullRequestInfo')
      .mockImplementationOnce(async () => {
        oldEntered.resolve();
        await releaseOld.promise;
        return null;
      })
      .mockImplementationOnce(async () => {
        newEntered.resolve();
        await releaseNew.promise;
        return null;
      });
    const fetch = jest.spyOn(internals(), 'refreshLikelyBase');
    const oldRead = service.getSummary(repoPath, 'branch');
    await oldEntered.promise;
    write('new.txt', 'new\n');
    git('add .');
    git('commit -m "new head"');
    const refresh = service.getSummary(repoPath, 'branch', true, true);
    await newEntered.promise;
    releaseOld.resolve();
    const oldResult = await oldRead;
    expect(oldResult.headSha).toBe(oldHead);
    expect(internals().baseCache.size).toBe(0);
    expect(internals().summaryCache.size).toBe(0);
    expect(internals().fileCountCache.size).toBe(0);
    expect(internals().baseBuilds.size).toBe(1);
    const concurrent = service.getSummary(repoPath, 'branch', false, true);
    const concurrentRefresh = service.getSummary(
      repoPath,
      'branch',
      true,
      true,
    );
    releaseNew.resolve();
    const fresh = await Promise.all([refresh, concurrent, concurrentRefresh]);
    expect(
      fresh.every((result) => result.headSha === git('rev-parse HEAD').trim()),
    ).toBe(true);
    expect(fresh.every((result) => result.files === fresh[0].files)).toBe(true);
    expect(metadata).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await service.getSummary(repoPath, 'branch')).headSha).toBe(
      fresh[0].headSha,
    );
  });

  it('detaches pending refreshes when a worktree is released and reused', async () => {
    setupOrigin();
    const entered = deferred();
    const release = deferred();
    jest.spyOn(internals(), 'refreshLikelyBase').mockResolvedValue();
    jest
      .spyOn(internals(), 'readPullRequestInfo')
      .mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return null;
      })
      .mockResolvedValue(null);
    const oldRefresh = service.getSummary(repoPath, 'branch', true);
    await entered.promise;
    service.releaseWorktree(repoPath);
    write('README.md', 'new head\n');
    git('commit -am "Reuse worktree"');
    try {
      const current = await service.getSummary(repoPath, 'branch');
      const refresh = service.getSummary(repoPath, 'branch', true);
      release.resolve();
      expect((await refresh).headSha).toBe(current.headSha);
      expect((await oldRefresh).headSha).not.toBe(current.headSha);
    } finally {
      release.resolve();
      await oldRefresh;
    }
  });

  it('rejects file lines that changed while their content build was queued', async () => {
    write('README.md', 'one\ntwo\n');
    const entered = deferred();
    const release = deferred();
    const original = service['getOrBuild'].bind(service);
    const builds = jest
      .spyOn(internals(), 'getOrBuild')
      .mockImplementation((map, key, build) =>
        original(
          map,
          key,
          map === internals().fileLinesBuilds
            ? async () => {
                entered.resolve();
                await release.promise;
                return build();
              }
            : build,
        ),
      );
    const read = () =>
      service.getContextWindow(repoPath, 'uncommitted', 'README.md', {
        oldStart: 1,
        newStart: 1,
        count: 1,
      });
    const old = read();
    const rejected = expect(old).rejects.toThrow('File changed while reading');
    await entered.promise;
    write('README.md', 'changed while queued\n');
    release.resolve();
    await rejected;
    builds.mockRestore();
    expect(internals().fileLinesCache.size).toBe(0);
    expect(internals().contextWindowCache.size).toBe(0);
    write('README.md', 'one\ntwo\n');
    expect((await read()).rows[0].content).toBe('one');
  });

  it('does not cache old rows, file lines, or context when they finish during replacement builds', async () => {
    write('README.md', 'one\ntwo\n');
    git('commit -am "second"');
    const oldEntered = deferred();
    const newEntered = deferred();
    const releaseOld = deferred();
    const releaseNew = deferred();
    const originalGetOrBuild = service['getOrBuild'].bind(service);
    let reads = 0,
      requests = 0;
    const builds = jest
      .spyOn(internals(), 'getOrBuild')
      .mockImplementation((map, key, build) => {
        if (map === internals().fileLinesBuilds && ++requests === 2)
          oldEntered.resolve();
        return originalGetOrBuild(
          map,
          key,
          map === internals().fileLinesBuilds
            ? async () => {
                const old = reads++ === 0;
                if (!old) newEntered.resolve();
                await (old ? releaseOld : releaseNew).promise;
                return build();
              }
            : build,
        );
      });
    const windows = () =>
      Promise.all([
        service.getFileWindow(repoPath, 'last-commit', 'README.md', {
          forceLoad: true,
        }),
        service.getContextWindow(repoPath, 'last-commit', 'README.md', {
          oldStart: 1,
          newStart: 1,
          count: 1,
          forceLoad: true,
        }),
      ]);
    const oldWindows = windows();
    await oldEntered.promise;
    await service.getSummary(repoPath, 'last-commit', true);
    const newWindows = windows();
    await newEntered.promise;
    releaseOld.resolve();
    await oldWindows;
    expect(internals().rowCache.size).toBe(0);
    expect(internals().fileLinesCache.size).toBe(0);
    expect(internals().contextWindowCache.size).toBe(0);
    expect(internals().rowBuilds.size).toBe(1);
    expect(internals().fileLinesBuilds.size).toBe(1);
    expect(internals().contextWindowBuilds.size).toBe(1);
    const joinedWindows = windows();
    releaseNew.resolve();
    await Promise.all([newWindows, joinedWindows]);
    expect(reads).toBe(2);
    builds.mockRestore();
    expect(internals().rowCache.size).toBe(1);
    expect(internals().fileLinesCache.size).toBe(1);
    expect(internals().contextWindowCache.size).toBe(1);
  });

  it('guards a large committed scope using filenames before building line diffs', async () => {
    commitTree(
      Array.from(
        { length: 2_001 },
        (_, index) =>
          `M 100644 inline bulk/file-${index}.txt\ndata 8\ncontent\n`,
      ),
    );
    const summaries = jest.spyOn(internals(), 'buildFileSummaries');
    const diffArgs = jest.spyOn(internals(), 'buildDiffArgs');
    const summary = await service.getSummary(repoPath, 'last-commit');
    expect(summary.loadGuard).toMatchObject({
      blocked: true,
      totalFiles: 2_001,
      reason: 'scope',
    });
    expect(summary.files).toEqual([]);
    expect(summaries).not.toHaveBeenCalled();
    expect(
      diffArgs.mock.calls.every(
        ([, , flags]) =>
          !flags.includes('--numstat') &&
          (flags.includes('--name-only') || flags.includes('--raw')),
      ),
    ).toBe(true);
    await expect(
      service.getFileWindow(repoPath, 'last-commit', 'bulk/file-0.txt'),
    ).rejects.toThrow(/Diff loading is paused/);
  });

  it('does not falsely guard a rename-heavy commit when the filename upper bound exceeds the limit', async () => {
    commitTree(
      Array.from(
        { length: 1_001 },
        (_, index) =>
          `M 100644 inline before/file-${index}.txt\ndata 8\ncontent\n`,
      ),
    );
    commitTree(
      Array.from(
        { length: 1_001 },
        (_, index) => `R before/file-${index}.txt after/file-${index}.txt`,
      ),
    );
    const diffArgs = jest.spyOn(internals(), 'buildDiffArgs');
    const summary = await service.getSummary(repoPath, 'last-commit');
    expect(summary.loadGuard).toBeNull();
    expect(summary.files).toHaveLength(1_001);
    expect(summary.files.every((file) => file.status === 'renamed')).toBe(true);
    const counts = diffArgs.mock.calls.filter(
      ([, , flags]) =>
        flags.includes('--name-only') ||
        (flags.includes('--raw') && !flags.includes('--numstat')),
    );
    expect(counts.map(([, , flags]) => flags)).toEqual([
      expect.arrayContaining(['--no-renames', '-z']),
      expect.arrayContaining(['--raw', '--find-renames', '-z']),
    ]);
  });

  it('counts paths containing newlines correctly', async () => {
    write('line\nbreak.txt', 'content\n');
    git('add .');
    git('commit -m "newline path"');
    const summary = await service.getSummary(repoPath, 'last-commit');
    expect(summary.files.map((file) => file.path)).toEqual(['line\nbreak.txt']);
    expect(summary.loadGuard).toBeNull();
  });

  it('does not remove a replacement promise when a cleared build completes', async () => {
    const builds = new Map<string, Promise<string>>();
    const releaseOld = deferred();
    const releaseNew = deferred();
    const old = internals().getOrBuild(builds, 'same-key', async () => {
      await releaseOld.promise;
      return 'old';
    });
    builds.clear();
    const replacement = internals().getOrBuild(builds, 'same-key', async () => {
      await releaseNew.promise;
      return 'new';
    });
    releaseOld.resolve();
    await old;
    expect(builds.get('same-key')).toBe(replacement);
    expect(
      internals().getOrBuild(builds, 'same-key', async () => 'unexpected'),
    ).toBe(replacement);
    releaseNew.resolve();
    expect(await replacement).toBe('new');
    expect(builds.size).toBe(0);
  });

  describe('branch scope with path-limited diffs', () => {
    const filePaths = (summary: { files: { path: string }[] }) =>
      summary.files.map((file) => file.path).sort();

    function startFeatureBranch(): string {
      const remotePath = path.join(tmpDir, 'remote.git');
      fs.mkdirSync(remotePath);
      git('init --bare', remotePath);
      git(`remote add origin ${remotePath}`);
      git('push -u origin main');
      git('symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main');
      git('checkout -b feature');
      return remotePath;
    }

    it('includes commits made after the review base was cached', async () => {
      startFeatureBranch();
      write('first.txt', 'first\n');
      git('add first.txt');
      git('commit -m "first"');
      expect(filePaths(await service.getSummary(repoPath, 'branch'))).toEqual([
        'first.txt',
      ]);

      write('second.txt', 'second\n');
      git('add second.txt');
      git('commit -m "second"');
      write('README.md', 'one\nedited\n');

      expect(filePaths(await service.getSummary(repoPath, 'branch'))).toEqual([
        'README.md',
        'first.txt',
        'second.txt',
      ]);
    });

    it('reports what an unrestricted diff against the merge-base reports', async () => {
      write('keep.txt', 'keep\n');
      write('rename-me.txt', 'rename me\n'.repeat(20));
      write('drop.txt', 'drop\n');
      git('add .');
      git('commit -m "more files"');
      startFeatureBranch();
      git('mv rename-me.txt renamed.txt');
      git('rm -q drop.txt');
      write('reverted.txt', 'temporary\n');
      git('add reverted.txt');
      git('commit -m "feature work"');
      // Reverted in the worktree: changed between merge-base and HEAD only.
      fs.rmSync(path.join(repoPath, 'reverted.txt'));
      write('keep.txt', 'keep\nstaged\n');
      git('add keep.txt');
      write('keep.txt', 'keep\nstaged\nunstaged\n');
      write('untracked/new.txt', 'new\n');

      const summary = await service.getSummary(repoPath, 'branch');

      const mergeBase = git('merge-base HEAD origin/main').trim();
      const expected = git(`diff --name-only -z --find-renames ${mergeBase}`)
        .split('\0')
        .filter(Boolean);
      expect(filePaths(summary)).toEqual(
        [...expected, 'untracked/new.txt'].sort(),
      );
      const [additions, deletions] = git(
        `diff --numstat --find-renames ${mergeBase}`,
      )
        .trim()
        .split('\n')
        .map((line) => line.split('\t'))
        .reduce(
          ([add, del], [a, d]) => [add + Number(a), del + Number(d)],
          [0, 0],
        );
      // Plus the one line of the untracked file.
      expect([summary.totals.additions, summary.totals.deletions]).toEqual([
        additions + 1,
        deletions,
      ]);
    });

    it('refreshes the remote default branch when there is no pull request', async () => {
      const remotePath = startFeatureBranch();
      const other = path.join(tmpDir, 'other');
      git(`clone -q -b main ${remotePath} ${other}`, tmpDir);
      git('config user.email "test@test.com"', other);
      git('config user.name "Test User"', other);
      git('commit -q --allow-empty -m "upstream moved"', other);
      git('push -q origin main', other);
      const pushed = git('rev-parse HEAD', other).trim();

      await service.getSummary(repoPath, 'branch', true);

      expect(git('rev-parse refs/remotes/origin/main').trim()).toBe(pushed);
    });

    it('still pauses branch scopes with too many committed files', async () => {
      startFeatureBranch();
      for (let index = 0; index <= 2_000; index++) {
        write(`bulk/${index}.txt`, `${index}\n`);
      }
      git('add bulk');
      git('commit -q -m "bulk"');

      const summary = await service.getSummary(repoPath, 'branch');

      expect(summary.loadGuard).toMatchObject({
        blocked: true,
        reason: 'scope',
        totalFiles: 2_001,
      });
    });
  });
});
