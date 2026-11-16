import type { SimpleGit, StatusResult } from 'simple-git';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  clearWorktreeFingerprintCache,
  readWorktreeFingerprint,
  readWorktreeStatusSnapshot,
} from './git-worktree-fingerprint.js';

// These tests exercise snapshot caching with a mocked simple-git; the real
// status reader has its own spec.
jest.mock('./worktree-status-reader.js', () => ({
  readWorktreeStatus: (
    _worktreePath: string,
    git: SimpleGit,
    statusArgs: string[],
  ) => git.status(statusArgs),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
    jest.restoreAllMocks();
    clearWorktreeFingerprintCache();
  });

  it('coalesces concurrent status snapshots for one worktree', async () => {
    const pending = deferred<StatusResult>();
    const git = {
      status: jest.fn(() => pending.promise),
    } as unknown as jest.Mocked<SimpleGit>;

    const reads = [
      readWorktreeStatusSnapshot('/tmp/repo', git),
      readWorktreeStatusSnapshot('/tmp/repo/.', git),
    ];
    pending.resolve(status());
    const [first, second] = await Promise.all(reads);

    expect(git.status.mock.calls).toHaveLength(1);
    expect(second).toBe(first);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses cached snapshots until invalidated', async () => {
    const git = {
      status: jest.fn().mockResolvedValue(status()),
    } as unknown as jest.Mocked<SimpleGit>;

    await readWorktreeStatusSnapshot('/tmp/repo', git);
    await readWorktreeStatusSnapshot('/tmp/repo', git);
    expect(git.status.mock.calls).toHaveLength(1);

    clearWorktreeFingerprintCache('/tmp/repo/');
    await readWorktreeStatusSnapshot(
      path.relative(process.cwd(), '/tmp/repo'),
      git,
    );
    expect(git.status.mock.calls).toHaveLength(2);
  });

  it('seeds the snapshot cache when a caller already has status', async () => {
    const git = {
      status: jest.fn().mockResolvedValue(status()),
    } as unknown as jest.Mocked<SimpleGit>;

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

    expect(git.status.mock.calls).toHaveLength(0);
    expect(snapshot.status).toBe(existingStatus);
    expect(snapshot.fingerprint).toBe(fingerprint);
  });

  it.each([
    { clearAll: false, failOld: false },
    { clearAll: true, failOld: false },
    { clearAll: false, failOld: true },
    { clearAll: true, failOld: true },
  ])(
    'keeps replacement scans coalesced after old completion (%j)',
    async ({ clearAll, failOld }) => {
      const oldStatus = deferred<StatusResult>();
      const freshStatus = deferred<StatusResult>();
      const git = {
        status: jest
          .fn()
          .mockReturnValueOnce(oldStatus.promise)
          .mockReturnValue(freshStatus.promise),
      } as unknown as jest.Mocked<SimpleGit>;
      const old = readWorktreeStatusSnapshot('/tmp/repo', git).catch(
        (error: unknown) => error,
      );
      clearWorktreeFingerprintCache(clearAll ? undefined : '/tmp/repo/');
      const fresh = readWorktreeStatusSnapshot('/tmp/repo', git);

      if (failOld) oldStatus.reject(new Error('old scan failed'));
      else oldStatus.resolve(status({ current: 'old' }));
      await old;
      const concurrent = readWorktreeStatusSnapshot('/tmp/repo/.', git);
      expect(git.status.mock.calls).toHaveLength(2);

      const replacementStatus = status({ current: 'fresh' });
      freshStatus.resolve(replacementStatus);
      const snapshot = await fresh;
      expect(await concurrent).toBe(snapshot);
      expect(await readWorktreeStatusSnapshot('/tmp/repo', git)).toBe(snapshot);
      expect(snapshot.status).toBe(replacementStatus);
    },
  );

  it.each([
    { invalidate: false, changedStat: false },
    { invalidate: false, changedStat: true },
    { invalidate: true, changedStat: false },
    { invalidate: true, changedStat: true },
  ])(
    'revalidates a replacement snapshot after an awaited stat (%j)',
    async ({ invalidate, changedStat }) => {
      const fileStat = await fs.stat(__filename);
      const stat = jest.spyOn(fs, 'lstat').mockResolvedValue(fileStat);
      const oldStatus = status({ modified: ['file.txt'], current: 'old' });
      const git = {
        status: jest.fn().mockResolvedValue(oldStatus),
      } as unknown as jest.Mocked<SimpleGit>;
      await readWorktreeStatusSnapshot('/tmp/repo', git);

      const validationStat = deferred<typeof fileStat>();
      stat.mockImplementationOnce(() => validationStat.promise);
      const validation = readWorktreeStatusSnapshot('/tmp/repo', git, {
        validateCached: true,
      });
      await Promise.resolve(); // The shared stat budget starts work asynchronously.
      expect(stat).toHaveBeenCalledTimes(2);
      if (invalidate) clearWorktreeFingerprintCache('/tmp/repo');
      const freshStatus = status({ modified: ['file.txt'], current: 'fresh' });
      await readWorktreeFingerprint('/tmp/repo', git, freshStatus);
      const fresh = await readWorktreeStatusSnapshot('/tmp/repo', git);

      validationStat.resolve(
        changedStat
          ? Object.assign(Object.create(fileStat) as typeof fileStat, {
              size: fileStat.size + 1,
            })
          : fileStat,
      );
      expect(await validation).toBe(fresh);
      expect(await readWorktreeStatusSnapshot('/tmp/repo', git)).toBe(fresh);
      expect(stat).toHaveBeenCalledTimes(4);
      expect(git.status.mock.calls).toHaveLength(1);
    },
  );

  it('starts a fresh scan when invalidated during cached stat validation', async () => {
    const fileStat = await fs.stat(__filename);
    const stat = jest.spyOn(fs, 'lstat').mockResolvedValue(fileStat);
    const freshStatus = status({ current: 'fresh' });
    const git = {
      status: jest
        .fn()
        .mockResolvedValueOnce(status({ modified: ['file.txt'] }))
        .mockResolvedValue(freshStatus),
    } as unknown as jest.Mocked<SimpleGit>;
    await readWorktreeStatusSnapshot('/tmp/repo', git);
    const validationStat = deferred<typeof fileStat>();
    stat.mockImplementationOnce(() => validationStat.promise);
    const validation = readWorktreeStatusSnapshot('/tmp/repo', git, {
      validateCached: true,
    });
    clearWorktreeFingerprintCache('/tmp/repo');
    validationStat.resolve(fileStat);

    expect((await validation).status).toBe(freshStatus);
    expect(git.status.mock.calls).toHaveLength(2);
  });

  it.each([false, true])(
    'does not publish supplied status after invalidation (clearAll=%s)',
    async (clearAll) => {
      const fileStat = await fs.stat(__filename);
      const oldStat = deferred<typeof fileStat>();
      jest.spyOn(fs, 'lstat').mockImplementationOnce(() => oldStat.promise);
      const freshStatus = status({ current: 'fresh' });
      const git = {
        status: jest.fn().mockResolvedValue(freshStatus),
      } as unknown as jest.Mocked<SimpleGit>;
      const old = readWorktreeFingerprint(
        '/tmp/repo/.',
        git,
        status({ modified: ['old.txt'] }),
      );
      clearWorktreeFingerprintCache(clearAll ? undefined : '/tmp/repo/');
      const fresh = await readWorktreeStatusSnapshot('/tmp/repo', git);
      oldStat.resolve(fileStat);

      expect(await old).toMatch(/^[a-f0-9]{64}$/);
      expect(await readWorktreeStatusSnapshot('/tmp/repo', git)).toBe(fresh);
    },
  );

  it('does not let older supplied status overwrite a newer publication', async () => {
    const fileStat = await fs.stat(__filename);
    const oldStat = deferred<typeof fileStat>();
    jest.spyOn(fs, 'lstat').mockImplementationOnce(() => oldStat.promise);
    const git = { status: jest.fn() } as unknown as jest.Mocked<SimpleGit>;
    const old = readWorktreeFingerprint(
      '/tmp/repo',
      git,
      status({ modified: ['old.txt'] }),
    );
    const freshStatus = status({ current: 'fresh' });
    await readWorktreeFingerprint('/tmp/repo', git, freshStatus);
    oldStat.resolve(fileStat);
    await old;

    expect((await readWorktreeStatusSnapshot('/tmp/repo', git)).status).toBe(
      freshStatus,
    );
    expect(git.status.mock.calls).toHaveLength(0);
  });

  it('does not let an older scan overwrite supplied status', async () => {
    const pending = deferred<StatusResult>();
    const git = {
      status: jest.fn().mockReturnValue(pending.promise),
    } as unknown as jest.Mocked<SimpleGit>;
    const old = readWorktreeStatusSnapshot('/tmp/repo', git);
    const freshStatus = status({ current: 'fresh' });
    await readWorktreeFingerprint('/tmp/repo', git, freshStatus);
    pending.resolve(status({ current: 'old' }));
    await old;

    expect((await readWorktreeStatusSnapshot('/tmp/repo', git)).status).toBe(
      freshStatus,
    );
  });

  it('does not rejoin an older scan when supplied status needs a fresh stat validation', async () => {
    const fileStat = await fs.stat(__filename);
    const stat = jest.spyOn(fs, 'lstat').mockResolvedValue(fileStat);
    const pending = deferred<StatusResult>();
    const latestStatus = status({ current: 'latest' });
    const git = {
      status: jest
        .fn()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(latestStatus),
    } as unknown as jest.Mocked<SimpleGit>;
    const old = readWorktreeStatusSnapshot('/tmp/repo', git);
    await readWorktreeFingerprint(
      '/tmp/repo',
      git,
      status({ modified: ['file.txt'] }),
    );
    stat.mockResolvedValue(
      Object.assign(Object.create(fileStat) as typeof fileStat, {
        size: fileStat.size + 1,
      }),
    );
    const latest = await readWorktreeStatusSnapshot('/tmp/repo', git, {
      validateCached: true,
    });
    expect(latest.status).toBe(latestStatus);
    expect(git.status.mock.calls).toHaveLength(2);
    pending.resolve(status({ current: 'old' }));
    await old;
    expect(await readWorktreeStatusSnapshot('/tmp/repo', git)).toBe(latest);
  });

  it('expires snapshots and rescans files whose stat signature changes', async () => {
    const fileStat = await fs.stat(__filename);
    const stat = jest.spyOn(fs, 'lstat').mockResolvedValue(fileStat);
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const git = {
      status: jest.fn().mockResolvedValue(status({ modified: ['file.txt'] })),
    } as unknown as jest.Mocked<SimpleGit>;
    const initial = await readWorktreeStatusSnapshot('/tmp/repo', git);
    stat.mockResolvedValue(
      Object.assign(Object.create(fileStat) as typeof fileStat, {
        size: fileStat.size + 1,
      }),
    );
    const changed = await readWorktreeStatusSnapshot('/tmp/repo', git, {
      validateCached: true,
    });
    expect(changed.fingerprint).not.toBe(initial.fingerprint);
    expect(git.status.mock.calls).toHaveLength(2);
    now.mockReturnValue(3_000);
    expect(await readWorktreeStatusSnapshot('/tmp/repo', git)).not.toBe(
      changed,
    );
    expect(git.status.mock.calls).toHaveLength(3);
  });

  it('bounds retained snapshots without evicting active scans or folding case', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const pending = deferred<StatusResult>();
    const git = {
      status: jest
        .fn()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(status()),
    } as unknown as jest.Mocked<SimpleGit>;
    const active = readWorktreeStatusSnapshot('/tmp/active', git);
    const first = await readWorktreeStatusSnapshot('/tmp/Repo', git);
    const lower = await readWorktreeStatusSnapshot('/tmp/repo', git);
    expect(lower).not.toBe(first);
    for (let i = 0; i < 1_000; i++)
      await readWorktreeStatusSnapshot(`/tmp/repo-${i}`, git);
    const concurrent = readWorktreeStatusSnapshot('/tmp/active', git);
    expect(git.status.mock.calls).toHaveLength(1_003);
    await readWorktreeStatusSnapshot('/tmp/repo-999', git);
    expect(git.status.mock.calls).toHaveLength(1_003);
    expect(await readWorktreeStatusSnapshot('/tmp/Repo', git)).not.toBe(first);
    expect(git.status.mock.calls).toHaveLength(1_004);
    pending.resolve(status());
    expect(await concurrent).toBe(await active);
  });

  it('rescans new paths on an absolute deadline under continuous supplied-status reuse', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const firstStatus = status();
    const newStatus = status({ not_added: ['new.txt'] });
    const git = {
      status: jest
        .fn()
        .mockResolvedValueOnce(firstStatus)
        .mockResolvedValue(newStatus),
    } as unknown as jest.Mocked<SimpleGit>;
    const first = await readWorktreeStatusSnapshot('/tmp/repo', git);
    for (const time of [1_500, 2_000]) {
      now.mockReturnValue(time);
      await readWorktreeFingerprint('/tmp/repo', git, first.status);
      expect(
        (await readWorktreeStatusSnapshot('/tmp/repo', git)).scannedAt,
      ).toBe(first.scannedAt);
    }
    now.mockReturnValue(2_500);
    await readWorktreeFingerprint('/tmp/repo', git, first.status);
    const fresh = await readWorktreeStatusSnapshot('/tmp/repo', git);
    expect(fresh.status.not_added).toEqual(['new.txt']);
    expect(fresh.scannedAt).toBe(2_500);
    expect(git.status).toHaveBeenCalledTimes(2);
  });

  it('coalesces validation passes without extending the authoritative scan deadline', async () => {
    const fileStat = await fs.stat(__filename);
    const stat = jest.spyOn(fs, 'lstat').mockResolvedValue(fileStat);
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const git = {
      status: jest.fn().mockResolvedValue(status({ modified: ['a', 'b'] })),
    } as unknown as jest.Mocked<SimpleGit>;
    const initial = await readWorktreeStatusSnapshot('/tmp/repo', git);
    now.mockReturnValue(2_000);
    await Promise.all(
      Array.from({ length: 32 }, () =>
        readWorktreeStatusSnapshot('/tmp/repo', git, { validateCached: true }),
      ),
    );
    expect(stat).toHaveBeenCalledTimes(4);
    now.mockReturnValue(2_500);
    expect(await readWorktreeStatusSnapshot('/tmp/repo', git)).not.toBe(
      initial,
    );
    expect(git.status).toHaveBeenCalledTimes(2);
    expect(git.status).toHaveBeenLastCalledWith(['--no-ahead-behind']);
  });
});
