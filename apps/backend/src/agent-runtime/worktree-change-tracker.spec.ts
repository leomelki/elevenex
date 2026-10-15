import * as fs from 'node:fs/promises';
import { promises as mutableFs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileAsync } from '../terminal/async-process.js';
import {
  ChangeContentBudget,
  WorktreeChangeTracker,
} from './worktree-change-tracker.js';

describe('WorktreeChangeTracker (real git and filesystem)', () => {
  let directory: string;
  let tracker: WorktreeChangeTracker | undefined;
  let budget: ChangeContentBudget;
  const git = (...args: string[]) =>
    execFileAsync('git', args, { cwd: directory });
  const write = (path: string, content: string | Buffer) =>
    fs.writeFile(join(directory, path), content);
  const commit = async () => {
    await git('add', '-A');
    await git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'fixture',
    );
  };

  beforeEach(async () => {
    directory = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), 'elevenex-changes-')),
    );
    budget = new ChangeContentBudget();
    await git('init', '-q');
    await write('.gitignore', 'node_modules/\nignored.txt\n');
    await write('source.ts', 'before\n');
    await write('delete.ts', 'delete me\n');
    await commit();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await tracker?.close();
    tracker = undefined;
    expect(budget.usedBytes).toBe(0);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('captures Python, cat redirection, dotfiles, renames, deletion and unusual filenames without editing the index', async () => {
    await write('source.ts', 'pre-existing unstaged edit\n');
    await write('existing-untracked.ts', 'already here\n');
    const indexBefore = await fs.readFile(join(directory, '.git/index'));
    tracker = await WorktreeChangeTracker.create(directory, budget);
    const turn = await tracker.begin();
    await execFileAsync(
      'python3',
      [
        '-c',
        'from pathlib import Path; Path("source.ts").write_text("pre-existing unstaged edit\\npython edit\\n"); Path(".hidden").write_text("hidden\\n")',
      ],
      { cwd: directory },
    );
    await execFileAsync(
      '/bin/sh',
      ['-c', "cat > created.ts <<'EOF'\nfrom cat\nEOF"],
      { cwd: directory },
    );
    await fs.rename(
      join(directory, 'delete.ts'),
      join(directory, 'renamed.ts'),
    );
    await write('new\nname\t.ts', 'odd name\n');
    const result = await tracker.finish(turn);
    expect(result.filesChanged.map((file) => file.path)).toEqual([
      '.hidden',
      'created.ts',
      'delete.ts',
      'new\nname\t.ts',
      'renamed.ts',
      'source.ts',
    ]);
    expect(
      result.filesChanged.find((file) => file.path === 'source.ts'),
    ).toMatchObject({ additions: 1, deletions: 0, status: 'modified' });
    expect(
      result.filesChanged.find((file) => file.path === 'delete.ts')?.status,
    ).toBe('deleted');
    expect(await fs.readFile(join(directory, '.git/index'))).toEqual(
      indexBefore,
    );
    expect(result.capture?.complete).toBe(true);
  });

  it('compares against the actual dirty starting state, including staged and untracked files', async () => {
    await write('source.ts', 'staged\n');
    await git('add', 'source.ts');
    await write('source.ts', 'staged\nunstaged\n');
    await write('existing.ts', 'existing\n');
    tracker = await WorktreeChangeTracker.create(directory, budget);
    const turn = await tracker.begin();
    await write('existing.ts', 'existing\nnew\n');
    const result = await tracker.finish(turn);
    expect(result.filesChanged.map((file) => file.path)).toEqual([
      'existing.ts',
    ]);
    expect(result.filesChanged[0]).toMatchObject({
      status: 'modified',
      additions: 1,
      deletions: 0,
    });
  });

  it('detects changes committed during a turn even when the final checkout is clean and events were lost', async () => {
    tracker = await WorktreeChangeTracker.create(directory, budget);
    const turn = await tracker.begin();
    await write('source.ts', 'committed during the turn\n');
    await commit();
    turn.paths.clear();
    const result = await tracker.finish(turn);
    expect(result.filesChanged[0]).toMatchObject({
      path: 'source.ts',
      additions: 1,
      deletions: 1,
    });
  });

  it('marks every overlapping turn shared and keeps each turn’s own starting state', async () => {
    tracker = await WorktreeChangeTracker.create(directory, budget);
    const first = await tracker.begin();
    await write('first.ts', 'first\n');
    const second = await tracker.begin();
    await write('second.ts', 'second\n');
    const [a, b] = await Promise.all([
      tracker.finish(first),
      tracker.finish(second),
    ]);
    expect(a.filesChanged.map((file) => file.path)).toEqual([
      'first.ts',
      'second.ts',
    ]);
    expect(b.filesChanged.map((file) => file.path)).toEqual(['second.ts']);
    expect(a.capture?.shared).toBe(true);
    expect(b.capture?.shared).toBe(true);
    expect(
      [...a.filesChanged, ...b.filesChanged].every(
        (file) => file.attribution === 'shared',
      ),
    ).toBe(true);
  });

  it('retains binary, large, empty and executable-only changes without pretending their line counts are known', async () => {
    tracker = await WorktreeChangeTracker.create(directory, budget);
    const turn = await tracker.begin();
    await write('binary', Buffer.from([0, 1, 2]));
    await write('large', Buffer.alloc(1024 * 1024, 'a'));
    await write('empty', '');
    await fs.chmod(join(directory, 'source.ts'), 0o755);
    const result = await tracker.finish(turn);
    expect(result.filesChanged.map((file) => file.path)).toEqual([
      'binary',
      'empty',
      'large',
      'source.ts',
    ]);
    expect(
      result.filesChanged.find((file) => file.path === 'binary')
        ?.diffUnavailable,
    ).toMatch(/Binary/);
    expect(
      result.filesChanged.find((file) => file.path === 'large')
        ?.diffUnavailable,
    ).toMatch(/large/);
    const next = await tracker.begin();
    expect((await tracker.finish(next)).files).toBe(0);
  });

  it('supports unborn repositories and reports no net change after an edit is reverted', async () => {
    await fs.rm(join(directory, '.git'), { recursive: true, force: true });
    await git('init', '-q');
    tracker = await WorktreeChangeTracker.create(directory, budget);
    const turn = await tracker.begin();
    await write('source.ts', 'temporary\n');
    await write('source.ts', 'before\n');
    expect((await tracker.finish(turn)).files).toBe(0);
  });

  it('does not read clean source contents on startup in a large repository, or include ignored dependency trees', async () => {
    await fs.mkdir(join(directory, 'node_modules'));
    const directories = Array.from({ length: 20 }, (_, n) => `dir-${n}`);
    await Promise.all(
      directories.map(async (dir) => {
        await fs.mkdir(join(directory, dir));
        await Promise.all(
          Array.from({ length: 100 }, (_, n) =>
            write(`${dir}/file-${n}.ts`, 'unchanged\n'),
          ),
        );
      }),
    );
    await write('node_modules/output', 'ignored\n');
    await commit();
    const opened = jest.spyOn(mutableFs, 'open');
    tracker = await WorktreeChangeTracker.create(directory, budget);
    const turn = await tracker.begin();
    expect(opened).not.toHaveBeenCalled();
    await write('dir-4/file-6.ts', 'changed\n');
    await write('node_modules/output', 'generated\n');
    const result = await tracker.finish(turn);
    expect(result.filesChanged.map((file) => file.path)).toEqual([
      'dir-4/file-6.ts',
    ]);
    expect(opened.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('honors the global memory budget while preserving file detection', async () => {
    budget = new ChangeContentBudget(10);
    await write('source.ts', 'a pre-existing file larger than the budget\n');
    tracker = await WorktreeChangeTracker.create(directory, budget);
    const turn = await tracker.begin();
    await write('source.ts', 'a different file larger than the budget\n');
    const result = await tracker.finish(turn);
    expect(result.filesChanged).toHaveLength(1);
    expect(result.filesChanged[0].diffUnavailable).toMatch(/memory limit/);
    expect(budget.usedBytes).toBeLessThanOrEqual(10);
  });

  it('includes ignored source/configuration files, without treating generated dependencies as source', async () => {
    await write('ignored.txt', 'before\n');
    tracker = await WorktreeChangeTracker.create(directory, budget);
    const turn = await tracker.begin();
    await write('ignored.txt', 'after\n');
    const result = await tracker.finish(turn);
    expect(result.filesChanged[0]).toMatchObject({
      path: 'ignored.txt',
      status: 'modified',
      additions: 1,
      deletions: 1,
    });
  });

  it('does not follow symlinks outside the checkout and cleans up cancelled captures', async () => {
    const outside = await fs.mkdtemp(join(tmpdir(), 'elevenex-outside-'));
    try {
      await fs.writeFile(join(outside, 'secret'), 'outside\n');
      await fs.symlink(outside, join(directory, 'link'));
      await commit();
      tracker = await WorktreeChangeTracker.create(directory, budget);
      const turn = await tracker.begin();
      turn.paths.add('link/secret');
      const result = await tracker.finish(turn);
      expect(result.filesChanged).toHaveLength(0);
      const cancelled = await tracker.begin();
      tracker.cancel(cancelled);
      expect(tracker.activeTurns).toBe(0);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
