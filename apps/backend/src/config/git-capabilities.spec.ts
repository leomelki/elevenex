import { GitCapabilitiesCache } from './git-capabilities.js';
import * as path from 'node:path';

describe('Git capability selection', () => {
  const env = { PATH: path.resolve('/tools') };
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['git version 2.25.1', false, false],
    ['git version 2.28.0', true, false],
    ['git version 2.35.8', true, false],
    ['git version 2.36.0', true, true],
    ['git version 2.49.1.windows.1', true, true],
    ['git version 2.50.1 (Apple Git-155)', true, true],
    ['git version 3.0.0', true, true],
    ['unknown wrapper', false, false],
  ])(
    'selects supported commands for %s',
    async (version, initialBranch, worktreeListNull) => {
      const cache = new GitCapabilitiesCache(() => Promise.resolve(version));
      expect(await cache.get('/repo', env)).toEqual({
        initialBranch,
        worktreeListNull,
      });
    },
  );

  it('shares a single in-flight probe across worktrees and reuses the result', async () => {
    let release!: (value: string) => void;
    const probe = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const cache = new GitCapabilitiesCache(probe);
    const requests = Array.from({ length: 20 }, (_, index) =>
      cache.get(`/worktree-${index}`, env),
    );
    expect(probe).toHaveBeenCalledTimes(1);
    release('git version 2.49.1');
    await Promise.all(requests);
    expect(await cache.get('/another-worktree', env)).toMatchObject({
      worktreeListNull: true,
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('separates effective PATHs and relative lookup directories', async () => {
    const probe = jest.fn(() => Promise.resolve('git version 2.49.1'));
    const cache = new GitCapabilitiesCache(probe);
    await cache.get('/one', env);
    await cache.get('/one', { PATH: path.resolve('/other-tools') });
    await cache.get('/one', { PATH: `.${path.delimiter}${env.PATH}` });
    await cache.get('/two', { PATH: `.${path.delimiter}${env.PATH}` });
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it('refreshes after an upgrade and evicts failed probes for retry', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const probe = jest
      .fn<Promise<string>, [string, NodeJS.ProcessEnv]>()
      .mockRejectedValueOnce(new Error('Git temporarily unavailable'))
      .mockResolvedValueOnce('git version 2.25.1')
      .mockResolvedValueOnce('git version 2.49.1');
    const cache = new GitCapabilitiesCache(probe);
    await expect(cache.get('/repo', env)).rejects.toThrow('unavailable');
    expect(await cache.get('/repo', env)).toMatchObject({
      worktreeListNull: false,
    });
    clock.mockReturnValue(302_000);
    expect(await cache.get('/repo', env)).toMatchObject({
      worktreeListNull: true,
    });
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('bounds retained toolchain identities', async () => {
    const probe = jest.fn(() => Promise.resolve('git version 2.49.1'));
    const cache = new GitCapabilitiesCache(probe);
    for (let index = 0; index < 65; index++)
      await cache.get('/repo', { PATH: path.resolve(`/tools-${index}`) });
    await cache.get('/repo', { PATH: path.resolve('/tools-0') });
    expect(probe).toHaveBeenCalledTimes(66);
  });
});
