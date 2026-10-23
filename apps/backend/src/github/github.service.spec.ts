import { GithubService } from './github.service.js';
import {
  GhCommandError,
  GhCommandRunnerService,
} from './gh-command-runner.service.js';
import {
  RepoContextResolverService,
  type RepoContext,
} from './repo-context-resolver.service.js';
import type { GitService } from '../git/git.service.js';

jest.mock('../git/git.service.js', () => ({ GitService: class {} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('GithubService request caching', () => {
  let context: RepoContext;
  let runner: { run: jest.Mock; isInstalled: jest.Mock };
  let resolver: { resolve: jest.Mock };
  let service: GithubService;
  const missingPr = () =>
    new GhCommandError(
      'no pull requests found',
      1,
      '',
      'no pull requests found',
    );

  beforeEach(() => {
    context = {
      repoRoot: '/repo',
      worktreePath: '/repo',
      branch: 'feature',
      headSha: 'abc',
      upstream: null,
      ahead: 0,
      behind: 0,
      remoteName: 'origin',
      host: 'github.com',
      owner: 'acme',
      repo: 'example',
    };
    runner = { run: jest.fn(), isInstalled: jest.fn().mockResolvedValue(true) };
    resolver = {
      resolve: jest.fn().mockImplementation(async () => ({ ...context })),
    };
    service = new GithubService(
      runner as unknown as GhCommandRunnerService,
      resolver as unknown as RepoContextResolverService,
      {} as GitService,
    );
  });

  it('caches missing pull requests and shares missing summaries between consumers', async () => {
    runner.run.mockRejectedValue(missingPr());
    expect(await service.getPullRequest('/repo')).toBeNull();
    expect(await service.getPullRequest('/repo')).toBeNull();
    expect(runner.run).toHaveBeenCalledTimes(1);

    await service.getBranchContext('/repo');
    await service.getPullRequestChecks('/repo');
    await service.getPullRequestDiff('/repo');
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent cold reads and allows retry after failure', async () => {
    const read = deferred<string>();
    runner.run.mockReturnValueOnce(read.promise);
    const first = service.getPullRequest('/repo');
    const second = service.getPullRequest('/repo');
    await Promise.resolve();
    await Promise.resolve();
    expect(runner.run).toHaveBeenCalledTimes(1);
    read.reject(new Error('network unavailable'));
    await expect(first).rejects.toThrow('network unavailable');
    await expect(second).rejects.toThrow('network unavailable');
    runner.run.mockRejectedValueOnce(missingPr());
    expect(await service.getPullRequest('/repo')).toBeNull();
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it('uses the current branch, HEAD and remote identity instead of a path-only cache', async () => {
    runner.run.mockRejectedValue(missingPr());
    await service.getPullRequest('/repo');
    context.branch = 'another';
    await service.getPullRequest('/repo');
    context.headSha = 'def';
    await service.getPullRequest('/repo');
    context.owner = 'different-owner';
    await service.getPullRequest('/repo');
    expect(runner.run).toHaveBeenCalledTimes(4);
    expect(runner.run.mock.calls[1][0]).toContain('another');
    expect(runner.run.mock.calls[3][0]).toContain('different-owner/example');
  });

  it('reuses one context snapshot throughout nested PR reads', async () => {
    runner.run.mockImplementation(async (args: string[]) =>
      args[1] === 'checks'
        ? '[]'
        : JSON.stringify({
            number: 1,
            title: 'PR',
            url: 'https://example/pr/1',
            state: 'OPEN',
            baseRefName: 'main',
            headRefName: 'feature',
            createdAt: 'today',
            updatedAt: 'today',
          }),
    );
    const detail = await service.getPullRequest('/repo');
    expect(detail?.number).toBe(1);
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
  });

  it('does not publish invalidated reads or let their cleanup remove a replacement', async () => {
    const old = deferred<string>();
    const current = deferred<string>();
    runner.run
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const first = service.getPullRequest('/repo');
    await Promise.resolve();
    await Promise.resolve();
    service.invalidate('/repo/./');
    const second = service.getPullRequest('/repo');
    await Promise.resolve();
    await Promise.resolve();
    old.reject(missingPr());
    expect(await first).toBeNull();
    const third = service.getPullRequest('/repo');
    await Promise.resolve();
    await Promise.resolve();
    expect(runner.run).toHaveBeenCalledTimes(2);
    current.reject(missingPr());
    expect(await second).toBeNull();
    expect(await third).toBeNull();
    expect(await service.getPullRequest('/repo')).toBeNull();
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it('refreshes explicit requests and evicts expired negative results', async () => {
    let now = 100;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      runner.run.mockRejectedValue(missingPr());
      await service.getPullRequest('/repo');
      await service.getPullRequest('/repo', true);
      now += 10_000;
      await service.getPullRequest('/repo');
      expect(runner.run).toHaveBeenCalledTimes(3);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps unrelated checkout reads cacheable when another checkout is invalidated', async () => {
    const read = deferred<string>();
    runner.run.mockReturnValue(read.promise);
    const pending = service.getPullRequest('/repo');
    await Promise.resolve();
    await Promise.resolve();
    service.invalidate('/another-checkout');
    read.reject(missingPr());
    expect(await pending).toBeNull();
    expect(await service.getPullRequest('/repo')).toBeNull();
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it('bounds retention across many branches', async () => {
    runner.run.mockRejectedValue(missingPr());
    for (let index = 0; index < 80; index++) {
      context.branch = `branch-${index}`;
      await service.getPullRequest('/repo');
    }
    context.branch = 'branch-79';
    await service.getPullRequest('/repo');
    expect(runner.run).toHaveBeenCalledTimes(80);
    context.branch = 'branch-0';
    await service.getPullRequest('/repo');
    expect(runner.run).toHaveBeenCalledTimes(81);
  });

  it('returns oversized conversations without retaining them in the cache', async () => {
    const body = 'a'.repeat(4 * 1024 * 1024);
    runner.run.mockImplementation(async (args: string[]) =>
      args[0] === 'api'
        ? '{}'
        : JSON.stringify({ number: 1, comments: [{ id: 1, body }] }),
    );
    expect(
      (await service.getPullRequestConversation('/repo')).comments[0].body,
    ).toBe(body);
    expect(
      (await service.getPullRequestConversation('/repo')).comments[0].body,
    ).toBe(body);
    expect(runner.run).toHaveBeenCalledTimes(4);
  });
});
