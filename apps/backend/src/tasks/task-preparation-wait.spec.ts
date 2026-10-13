import { TasksService } from './tasks.service.js';

function fixture() {
  let state = 'preparing';
  let resolve!: () => void;
  const operation = new Promise<void>((done) => {
    resolve = done;
  });
  const operations = new Map([[9, operation]]);
  const record = jest.fn(async () => ({
    id: 9,
    taskState: state,
    archivedAt: null,
  }));
  const get = jest.fn(async () => ({
    id: 9,
    taskState: state,
    archivedAt: null,
    sessions: [],
  }));
  const service = Object.assign(Object.create(TasksService.prototype), {
    operations,
    record,
    get,
  }) as TasksService;
  return {
    service,
    operations,
    record,
    get,
    ready: () => {
      state = 'ready';
      resolve();
    },
  };
}

describe('task preparation wait', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('awaits the existing setup operation without scanning the checkout while pending', async () => {
    const f = fixture();
    const waiting = f.service.waitForPreparation(
      9,
      30000,
      new AbortController().signal,
    );
    await Promise.resolve();
    expect(f.get).not.toHaveBeenCalled();
    f.ready();
    await expect(waiting).resolves.toMatchObject({
      task: { taskState: 'ready' },
      timedOut: false,
    });
    expect(f.record).toHaveBeenCalledTimes(2);
    expect(f.get).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('times out without stopping the accepted operation and clears its timer', async () => {
    const f = fixture();
    const waiting = f.service.waitForPreparation(
      9,
      1000,
      new AbortController().signal,
    );
    await jest.advanceTimersByTimeAsync(1000);
    await expect(waiting).resolves.toMatchObject({
      task: { taskState: 'preparing' },
      timedOut: true,
    });
    expect(f.operations.has(9)).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    f.ready();
  });

  it('cancels only the wait and removes the abort listener', async () => {
    const f = fixture();
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    const waiting = f.service.waitForPreparation(9, 30000, controller.signal);
    const rejection = expect(waiting).rejects.toThrow('cancelled');
    await Promise.resolve();
    controller.abort(new Error('cancelled'));
    await rejection;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(f.operations.has(9)).toBe(true);
    expect(f.get).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    f.ready();
  });

  it('observes one DB row during startup recovery when no operation is registered yet', async () => {
    const f = fixture();
    f.operations.clear();
    const waiting = f.service.waitForPreparation(
      9,
      30000,
      new AbortController().signal,
    );
    await Promise.resolve();
    f.ready();
    await jest.advanceTimersByTimeAsync(250);
    await expect(waiting).resolves.toMatchObject({ timedOut: false });
    expect(f.get).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('discards the final observation if cancellation arrives during checkout verification', async () => {
    const f = fixture();
    f.ready();
    let finish!: (value: {
      id: number;
      taskState: string;
      archivedAt: null;
      sessions: never[];
    }) => void;
    f.get.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const controller = new AbortController();
    const waiting = f.service.waitForPreparation(9, 30000, controller.signal);
    const rejection = expect(waiting).rejects.toThrow('cancelled');
    await Promise.resolve();
    expect(f.get).toHaveBeenCalledTimes(1);
    controller.abort(new Error('cancelled'));
    finish({ id: 9, taskState: 'ready', archivedAt: null, sessions: [] });
    await rejection;
  });
});
