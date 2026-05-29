import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { ChangeReviewService } from './change-review.service.js';

describe('ChangeReviewService', () => {
  let service: ChangeReviewService;
  let tmpDir: string;
  let repoPath: string;

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
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
});
