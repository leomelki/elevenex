import { NavigationEventsService } from './navigation-events.service.js';

describe('navigation revision waits', () => {
  afterEach(() => jest.useRealTimers());
  it('wakes immediately for a change and catches changes between observation and registration', async () => {
    jest.useFakeTimers();
    const events = new NavigationEventsService(),
      controller = new AbortController();
    const resolved = jest.fn();
    const pending = events.wait(0, controller.signal).then(resolved);
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    events.invalidate();
    await pending;
    expect(resolved).toHaveBeenCalledTimes(1);
    await events.wait(0, controller.signal);
    // Thousands of revisions are scalar updates, with no event replay/snapshots.
    for (let i = 0; i < 5000; i++) events.invalidate();
    expect(events.revision).toBe(5001);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('bounds concurrent observers and refuses new waits after shutdown', async () => {
    jest.useFakeTimers();
    const events = new NavigationEventsService(),
      controller = new AbortController();
    const waits = Array.from({ length: 1024 }, () =>
      events.wait(0, new AbortController().signal),
    );
    expect(() => events.wait(0, controller.signal)).toThrow(
      'Too many navigation observers',
    );
    events.onModuleDestroy();
    await Promise.all(waits);
    await events.wait(0, controller.signal);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('releases listeners and timers on timeout, cancellation and shutdown', async () => {
    jest.useFakeTimers();
    const events = new NavigationEventsService(),
      controller = new AbortController();
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    const pending = events.wait(0, controller.signal);
    controller.abort();
    await pending;
    expect(remove).toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    await events.wait(0, controller.signal);
    const timeout = events.wait(0, new AbortController().signal);
    jest.advanceTimersByTime(25000);
    await timeout;
    const waits = Array.from({ length: 100 }, () =>
      events.wait(0, new AbortController().signal),
    );
    events.onModuleDestroy();
    await Promise.all(waits);
    expect(jest.getTimerCount()).toBe(0);
  });
});
