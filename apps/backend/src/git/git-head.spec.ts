import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { worktreeSimpleGit } from '../config/system-paths.js';
import { readCurrentBranch } from './git-head.js';

jest.setTimeout(30_000);

describe('readCurrentBranch', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-head-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'core.hooksPath', '/dev/null');
    git('config', 'commit.gpgSign', 'false');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('names an unborn branch', async () => {
    await expect(readCurrentBranch(worktreeSimpleGit(repo))).resolves.toBe(
      'main',
    );
  });

  it('names the branch even when a tag shares its name', async () => {
    git('commit', '-q', '--allow-empty', '-m', 'init');
    git('switch', '-q', '-c', 'feature/x');
    git('update-ref', 'refs/tags/feature/x', 'HEAD');
    await expect(readCurrentBranch(worktreeSimpleGit(repo))).resolves.toBe(
      'feature/x',
    );
  });

  it('returns null for a detached HEAD', async () => {
    git('commit', '-q', '--allow-empty', '-m', 'init');
    git('switch', '-q', '--detach');
    await expect(readCurrentBranch(worktreeSimpleGit(repo))).resolves.toBe(
      null,
    );
  });

  it('rejects outside a repository', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      await expect(
        readCurrentBranch(worktreeSimpleGit(outside)),
      ).rejects.toThrow();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
