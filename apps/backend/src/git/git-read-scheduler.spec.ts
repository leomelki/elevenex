import {
  GitWorkScheduler,
  consumeSharedGitWork,
  gitHashScheduler,
  gitRenderScheduler,
} from './git-read-scheduler.js';

describe('shared Git scheduling', () => {
  it('lets bounded renders await the separate content budget', async () => {
    let release!: () => void;
    const pending = new Promise<void>((done) => {
      release = done;
    });
    const renders = Array.from({ length: 8 }, () =>
      gitRenderScheduler.run('render-repo', () =>
        gitHashScheduler.run('render-repo', () => pending),
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(gitRenderScheduler.diagnostics().active).toBe(4);
    expect(gitHashScheduler.diagnostics().active).toBe(2);
    release();
    await Promise.all(renders);
  });
  it.each([
    [8, 4],
    [32, 16],
    [4, 2],
  ])(
    'enforces production-sized global %i and repository %i limits',
    async (globalLimit, repositoryLimit) => {
      const scheduler = new GitWorkScheduler(globalLimit, repositoryLimit);
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const requests = Array.from({ length: 64 }, (_, i) =>
        scheduler.run(`repo-${Math.floor(i / repositoryLimit)}`, () => pending),
      );
      expect(scheduler.diagnostics().active).toBe(globalLimit);
      expect(scheduler.diagnostics().peakRepositoryActive).toBe(
        repositoryLimit,
      );
      release();
      await Promise.all(requests);
      expect(scheduler.diagnostics().peakActive).toBe(globalLimit);
      expect(scheduler.diagnostics().pending).toBe(0);
    },
  );
  it('cancels an obsolete consumer without rejecting another waiter on the same build', async () => {
    let finish!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const controller = new AbortController();
    const obsolete = consumeSharedGitWork(pending, controller.signal).catch(
      (error) => error,
    );
    const current = consumeSharedGitWork(pending);
    controller.abort(new Error('obsolete'));
    expect((await obsolete).message).toBe('obsolete');
    finish('rows');
    expect(await current).toBe('rows');
  });
  it('bounds total/repository concurrency, prioritizes visible work, and cancels queued work', async () => {
    const scheduler = new GitWorkScheduler(2, 1);
    let release!: () => void;
    const entered = new Promise<void>((done) => {
      release = done;
    });
    const order: string[] = [];
    const first = scheduler.run('repo', () => entered);
    const background = scheduler.run('repo', async () => {
      order.push('background');
    });
    const visible = scheduler.run(
      'repo',
      async () => {
        order.push('visible');
      },
      10,
    );
    const abort = new AbortController();
    const cancelled = scheduler
      .run(
        'repo',
        async () => {
          throw new Error('must not run');
        },
        20,
        abort.signal,
      )
      .catch((error) => error);
    abort.abort(new Error('obsolete'));
    await scheduler.run('other', async () => {
      order.push('other');
    });
    expect(scheduler.diagnostics().peakActive).toBe(2);
    release();
    await Promise.all([first, background, visible]);
    expect(order).toEqual(['other', 'visible', 'background']);
    expect((await cancelled).message).toBe('obsolete');
    expect(scheduler.diagnostics().pending).toBe(0);
  });
});
