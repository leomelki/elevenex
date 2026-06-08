import type { SimpleGit, StatusResult } from 'simple-git';
import {
  clearWorktreeFingerprintCache,
  readWorktreeFingerprint,
  readWorktreeStatusSnapshot,
} from './git-worktree-fingerprint.js';

function status(overrides: Partial<StatusResult> = {}): StatusResult {
  return {
    not_added: [],
    conflicted: [],
    created: [],
    deleted: [],
    ignored: undefined,
    modified: [],
    renamed: [],
    files: [],
    staged: [],
    ahead: 0,
    behind: 0,
    current: 'main',
    tracking: null,
    detached: false,
    isClean: () => true,
    ...overrides,
  };
}

describe('git worktree fingerprint cache', () => {
  beforeEach(() => {
    clearWorktreeFingerprintCache();
  });

  afterEach(() => {
    clearWorktreeFingerprintCache();
  });

  it('coalesces concurrent status snapshots for one worktree', async () => {
    const git = {
      status: jest.fn(
        () =>
          new Promise<StatusResult>((resolve) => {
            setTimeout(() => resolve(status()), 10);
          }),
      ),
    } as unknown as SimpleGit;

    const [first, second] = await Promise.all([
      readWorktreeStatusSnapshot('/tmp/repo', git),
      readWorktreeStatusSnapshot('/tmp/repo', git),
    ]);

    expect(git.status).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses cached snapshots until invalidated', async () => {
    const git = {
      status: jest.fn().mockResolvedValue(status()),
    } as unknown as SimpleGit;

    await readWorktreeStatusSnapshot('/tmp/repo', git);
    await readWorktreeStatusSnapshot('/tmp/repo', git);
    expect(git.status).toHaveBeenCalledTimes(1);

    clearWorktreeFingerprintCache('/tmp/repo');
    await readWorktreeStatusSnapshot('/tmp/repo', git);
    expect(git.status).toHaveBeenCalledTimes(2);
  });

  it('seeds the snapshot cache when a caller already has status', async () => {
    const git = {
      status: jest.fn().mockResolvedValue(status()),
    } as unknown as SimpleGit;

    const existingStatus = status({
      modified: ['src/a.ts'],
      files: [
        {
          path: 'src/a.ts',
          index: ' ',
          working_dir: 'M',
        },
      ],
    });

    const fingerprint = await readWorktreeFingerprint(
      '/tmp/repo',
      git,
      existingStatus,
    );
    const snapshot = await readWorktreeStatusSnapshot('/tmp/repo', git);

    expect(git.status).not.toHaveBeenCalled();
    expect(snapshot.status).toBe(existingStatus);
    expect(snapshot.fingerprint).toBe(fingerprint);
  });
});
