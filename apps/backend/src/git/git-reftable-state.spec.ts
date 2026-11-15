import { join } from 'node:path';
import { ReftableRefCache } from './git-reftable-state.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('reftable ref cache ownership and freshness', () => {
  const identity = {
    gitDir: '/repo/.git/worktrees/task',
    commonDir: '/repo/.git',
  };
  const sha = 'a'.repeat(40);
  let versions: Map<string, string>;
  let cache: ReftableRefCache;
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    versions = new Map();
    cache = new ReftableRefCache(
      (file) => Promise.resolve(versions.get(file) ?? 'one'),
      1_500,
    );
  });
  afterEach(() => {
    cache.clear();
    jest.restoreAllMocks();
  });
  const reader = () =>
    jest.fn((args: string[]) =>
      Promise.resolve(args[0] === 'symbolic-ref' ? 'refs/heads/main' : sha),
    );

  it('coalesces bursts and serves unchanged HEAD and refs without more Git', async () => {
    const read = reader();
    const heads = await Promise.all(
      Array.from({ length: 64 }, () => cache.head(identity, read)),
    );
    expect(
      heads.every((head) => head.sha === sha && head.ref === 'refs/heads/main'),
    ).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    await cache.head(identity, read);
    expect(read).toHaveBeenCalledTimes(2);
    await Promise.all(
      Array.from({ length: 64 }, () =>
        cache.resolve(identity, 'refs/remotes/origin/main', false, read),
      ),
    );
    expect(read).toHaveBeenCalledTimes(3);
    await cache.resolve(identity, 'refs/remotes/origin/main', false, read);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each(['gitDir', 'commonDir'] as const)(
    'invalidates immediately when %s tables change',
    async (directory) => {
      const read = reader();
      await cache.head(identity, read);
      versions.set(join(identity[directory], 'reftable', 'tables.list'), 'two');
      read.mockImplementation((args) =>
        Promise.resolve(
          args[0] === 'symbolic-ref' ? 'refs/heads/switched' : sha,
        ),
      );
      expect(await cache.head(identity, read)).toMatchObject({
        ref: 'refs/heads/switched',
        sha,
      });
      expect(read).toHaveBeenCalledTimes(4);
    },
  );

  it('retries a failed Git read without requiring another ref update', async () => {
    const read = reader();
    read.mockRejectedValueOnce(new Error('Git unavailable'));
    await expect(cache.head(identity, read)).rejects.toThrow('Git unavailable');
    expect((await cache.head(identity, read)).sha).toBe(sha);
    read.mockRejectedValueOnce(new Error('Git unavailable'));
    await expect(
      cache.resolve(identity, 'refs/remotes/origin/main', false, read),
    ).rejects.toThrow('Git unavailable');
    expect(
      await cache.resolve(identity, 'refs/remotes/origin/main', false, read),
    ).toBe(sha);
  });

  it('does not repopulate a released cache from an old in-flight read', async () => {
    const gate = deferred<string>();
    const oldRead = jest.fn((args: string[]) =>
      gate.promise.then((value) =>
        args[0] === 'symbolic-ref' ? 'refs/heads/old' : value,
      ),
    );
    const old = cache.head(identity, oldRead);
    await new Promise((resolve) => setImmediate(resolve));
    cache.clear(identity.gitDir);
    const freshRead = reader();
    const fresh = await cache.head(identity, freshRead);
    gate.resolve('b'.repeat(40));
    await old;
    expect(await cache.head(identity, freshRead)).toEqual(fresh);
    expect(freshRead).toHaveBeenCalledTimes(2);
  });

  it('bounds cached ref choices per checkout', async () => {
    const read = reader();
    for (let index = 0; index < 33; index++)
      await cache.resolve(identity, `refs/heads/branch-${index}`, false, read);
    expect(read).toHaveBeenCalledTimes(33);
    await cache.resolve(identity, 'refs/heads/branch-32', false, read);
    expect(read).toHaveBeenCalledTimes(33);
    await cache.resolve(identity, 'refs/heads/branch-0', false, read);
    expect(read).toHaveBeenCalledTimes(34);
  });

  it('does not overwrite a replacement ref cache when an older request completes after release', async () => {
    const gate = deferred<string>();
    const old = cache.resolve(
      identity,
      'refs/remotes/origin/main',
      false,
      () => gate.promise,
    );
    await new Promise((resolve) => setImmediate(resolve));
    cache.clear(identity.gitDir);
    const next = 'b'.repeat(40);
    const read = jest.fn(() => Promise.resolve(next));
    expect(
      await cache.resolve(identity, 'refs/remotes/origin/main', false, read),
    ).toBe(next);
    gate.resolve(sha);
    await old;
    expect(
      await cache.resolve(identity, 'refs/remotes/origin/main', false, read),
    ).toBe(next);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('periodically verifies HEAD and remote refs even when filesystem versions remain unchanged', async () => {
    const read = reader();
    await cache.head(identity, read);
    await cache.resolve(identity, 'refs/remotes/origin/main', false, read);
    jest.mocked(Date.now).mockReturnValue(2_500);
    const next = 'b'.repeat(40);
    read.mockImplementation((args) =>
      Promise.resolve(
        args[0] === 'symbolic-ref' ? 'refs/heads/switched' : next,
      ),
    );
    expect(await cache.head(identity, read)).toMatchObject({
      ref: 'refs/heads/switched',
      sha: next,
    });
    expect(
      await cache.resolve(identity, 'refs/remotes/origin/main', false, read),
    ).toBe(next);
    expect(read).toHaveBeenCalledTimes(6);
    jest.mocked(Date.now).mockReturnValue(900);
    await cache.head(identity, read);
    expect(read).toHaveBeenCalledTimes(8);
  });
});
