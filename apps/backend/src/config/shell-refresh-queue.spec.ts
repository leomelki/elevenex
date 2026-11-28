import { ShellRefreshQueue } from './shell-refresh-queue.js';

describe('bounded shell capture admission', () => {
  const running: {
    cwd: string | undefined;
    signal: AbortSignal;
    finish: (env: NodeJS.ProcessEnv | null) => void;
  }[] = [];
  let queue: ShellRefreshQueue;
  beforeEach(() => {
    jest.useFakeTimers();
    running.length = 0;
    queue = new ShellRefreshQueue(
      { concurrency: 1, maxPending: 2, queueTimeoutMs: 100 },
      (cwd, signal) =>
        new Promise((resolve) =>
          running.push({ cwd, signal, finish: resolve }),
        ),
    );
  });
  afterEach(async () => {
    queue.dispose();
    await jest.runAllTimersAsync();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
  const finish = async (index: number) => {
    running[index].finish({ PATH: `/${index}/bin` });
    await jest.advanceTimersByTimeAsync(0);
  };

  it('coalesces captures and promotes a required read ahead of background work', async () => {
    const active = queue.request('active');
    const optional = queue.request('optional');
    const selected = queue.request('selected');
    expect(queue.request('selected', true)).toBe(selected);
    await finish(0);
    expect(running[1].cwd).toBe('selected');
    await finish(1);
    expect(running[2].cwd).toBe('optional');
    await finish(2);
    await Promise.all([active, optional, selected]);
  });

  it('bounds required work under a 1000-request burst and rejects overflow promptly', async () => {
    const active = queue.request('active');
    const requests = Array.from({ length: 1000 }, (_, i) =>
      queue.request(`required-${i}`, true).then(
        () => 'accepted',
        () => 'busy',
      ),
    );
    expect(running).toHaveLength(1);
    await finish(0);
    await finish(1);
    await finish(2);
    const results = await Promise.all(requests);
    expect(results.filter((result) => result === 'accepted')).toHaveLength(2);
    expect(results.filter((result) => result === 'busy')).toHaveLength(998);
    expect(running).toHaveLength(3);
    await active;
  });

  it('evicts only optional queued work and reserves admission for global setup', async () => {
    const active = queue.request('active');
    const dropped = queue.request('optional');
    const selected = queue.request('selected', true);
    const required = queue.request('required', true);
    await expect(dropped).resolves.toBeNull();
    const global = queue.request();
    await finish(0);
    expect(running[1].cwd).toBeUndefined();
    await finish(1);
    await finish(2);
    await finish(3);
    await Promise.all([active, selected, required, global]);
  });

  it('expires queued reads without ever spawning them', async () => {
    const active = queue.request('active');
    const queued = queue.request('queued', true);
    const rejection = expect(queued).rejects.toThrow('waited too long');
    await jest.advanceTimersByTimeAsync(100);
    await rejection;
    await finish(0);
    await active;
    expect(running).toHaveLength(1);
    expect(queue.has('queued')).toBe(false);
  });

  it('aborts active captures and settles queued callers on shutdown, ignoring late replies', async () => {
    const active = queue.request('active', true);
    const queued = queue.request('queued', true);
    queue.dispose();
    expect(running[0].signal.aborted).toBe(true);
    await expect(active).resolves.toBeNull();
    await expect(queued).resolves.toBeNull();
    await finish(0);
    await expect(queue.request('after-shutdown')).resolves.toBeNull();
    expect(running).toHaveLength(1);
  });
});
