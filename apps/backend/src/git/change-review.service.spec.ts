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
});
