import { execFile } from 'node:child_process';
import { mkdtemp, copyFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readCommitMessageDiff } from './git-commit-message-diff.js';

const execute = promisify(execFile);
describe('commit message diff context', () => {
  let root: string;
  const git = async (...args: string[]) =>
    (await execute('git', args, { cwd: root, timeout: 10_000 })).stdout;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'elevenex-commit-diff-'));
    await git('init');
    await writeFile(
      join(root, 'change.txt'),
      'a small change with Unicode: café\n',
    );
    await git('add', '--all');
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('reads small staged diffs completely, preserving Unicode and disabling text conversion', async () => {
    await git('config', 'diff.test.textconv', 'elevenex-missing-textconv');
    await writeFile(join(root, '.gitattributes'), '*.txt diff=test\n');
    const diff = await readCommitMessageDiff(root, 24_000);
    expect(diff).toContain('+a small change with Unicode: café');
    expect(diff).toBe(await git('diff', '--cached', '--no-textconv'));
  });

  it('returns only the prompt prefix and one overflow character for very large patches', async () => {
    await writeFile(join(root, 'change.txt'), 'large change\n'.repeat(100_000));
    await git('add', '--all');
    const prefix = await readCommitMessageDiff(root, 1000);
    expect(prefix).toHaveLength(1001);
    expect(prefix).toContain('+large change');
    // The prefix process must be gone before this resolves, even on overflow.
    expect(await readCommitMessageDiff(root, 10)).toHaveLength(11);
  });

  it('isolates inherited Git overrides and honors only an explicitly supplied snapshot index', async () => {
    const index = join(root, 'snapshot-index');
    await copyFile(join(root, '.git', 'index'), index);
    await writeFile(join(root, 'change.txt'), 'later staging\n');
    await git('add', '--all');
    jest.replaceProperty(process, 'env', {
      ...process.env,
      GIT_DIR: join(root, 'missing-repository'),
      GIT_WORK_TREE: join(root, 'missing-worktree'),
      GIT_INDEX_FILE: join(root, 'missing-index'),
    });
    expect(await readCommitMessageDiff(root, 24_000, index)).toContain(
      '+a small change',
    );
    expect(await readCommitMessageDiff(root, 24_000)).toContain(
      '+later staging',
    );
  });

  it('rejects Git errors and failed process startup instead of returning partial context', async () => {
    await expect(
      readCommitMessageDiff(join(root, 'missing'), 1000),
    ).rejects.toThrow();
    const invalidIndex = join(root, 'invalid-index');
    await writeFile(invalidIndex, 'invalid index');
    await expect(
      readCommitMessageDiff(root, 1000, invalidIndex),
    ).rejects.toThrow();
  });
});
