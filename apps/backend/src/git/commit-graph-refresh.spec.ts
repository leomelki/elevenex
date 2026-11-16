import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  refreshCommitGraphAfterFetch,
  settleCommitGraphRefreshes,
} from './commit-graph-refresh.js';

jest.setTimeout(30_000);

describe('refreshCommitGraphAfterFetch', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const chainPath = () =>
    path.join(
      repo,
      '.git',
      'objects',
      'info',
      'commit-graphs',
      'commit-graph-chain',
    );

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-graph-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'core.hooksPath', '/dev/null');
    git('config', 'commit.gpgSign', 'false');
    for (const message of ['one', 'two', 'three']) {
      git('commit', '-q', '--allow-empty', '-m', message);
    }
  });

  afterEach(async () => {
    await settleCommitGraphRefreshes();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('writes an incremental layer covering the fetched tips', async () => {
    refreshCommitGraphAfterFetch(repo, [
      'refs/heads/main',
      'refs/heads/missing',
    ]);
    await settleCommitGraphRefreshes();

    expect(fs.existsSync(chainPath())).toBe(true);
    expect(() => git('commit-graph', 'verify', '--no-progress')).not.toThrow();
  });

  it('respects core.commitGraph=false and fetch.writeCommitGraph=false', async () => {
    git('config', 'fetch.writeCommitGraph', 'false');
    refreshCommitGraphAfterFetch(repo, ['refs/heads/main']);
    await settleCommitGraphRefreshes();
    expect(fs.existsSync(chainPath())).toBe(false);

    git('config', '--unset', 'fetch.writeCommitGraph');
    git('config', 'core.commitGraph', 'false');
    refreshCommitGraphAfterFetch(repo, ['refs/heads/main']);
    await settleCommitGraphRefreshes();
    expect(fs.existsSync(chainPath())).toBe(false);
  });
});
