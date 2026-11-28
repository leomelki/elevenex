import { TerminalPortDiscovery } from './terminal-port-discovery.js';
import type { TerminalPortSnapshot } from './terminal-port-snapshot.js';

const snapshot = (
  pid: number,
  port = 4200,
  started = 1,
): TerminalPortSnapshot => ({
  roots: new Map([[pid, started]]),
  listeners: new Map([[pid, [{ pid, started, host: '127.0.0.1', port }]]]),
});

it('coalesces across windows/terminals, caches scans and bypasses the cache for explicit verification', async () => {
  const scan = jest.fn(() => Promise.resolve(snapshot(10)));
  const discovery = new TerminalPortDiscovery(scan);
  const receive = jest.fn();
  discovery.register(1, 10, receive);
  const first = discovery.refresh();
  expect(discovery.refresh()).toBe(first);
  await first;
  await discovery.refresh();
  expect(scan).toHaveBeenCalledTimes(1);
  expect(receive).toHaveBeenCalledWith(snapshot(10).listeners.get(10));
  await discovery.refresh(true);
  expect(scan).toHaveBeenCalledTimes(2);
  discovery.dispose();
});

it('discards replies for closed/replaced registrations, even when the terminal ID is reused', async () => {
  let finish!: (value: TerminalPortSnapshot) => void;
  const scan = jest.fn(
    () =>
      new Promise<TerminalPortSnapshot>((resolve) => {
        finish = resolve;
      }),
  );
  const discovery = new TerminalPortDiscovery(scan);
  const old = jest.fn(),
    next = jest.fn();
  const stop = discovery.register(1, 10, old);
  const first = discovery.refresh();
  await Promise.resolve();
  discovery.register(1, 20, next);
  stop();
  finish(snapshot(10));
  await first;
  expect(old).not.toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
  const second = discovery.refresh();
  await Promise.resolve();
  expect(scan.mock.calls).toHaveLength(2);
  finish(snapshot(20));
  await second;
  expect(next).toHaveBeenCalledWith(snapshot(20).listeners.get(20));
  discovery.dispose();
});

it('fails closed on scan failure or root PID reuse, and recovers from unavailable collectors', async () => {
  const scan = jest.fn(() => Promise.resolve(snapshot(10)));
  const discovery = new TerminalPortDiscovery(scan);
  const receive = jest.fn();
  discovery.register(1, 10, receive);
  await discovery.refresh();
  scan.mockRejectedValueOnce(new Error('EACCES'));
  await discovery.refresh(true);
  expect(receive).toHaveBeenLastCalledWith(null);
  await discovery.refresh(true);
  expect(receive).toHaveBeenLastCalledWith(snapshot(10).listeners.get(10));
  scan.mockResolvedValueOnce(snapshot(10, 4200, 2));
  await discovery.refresh(true);
  expect(receive).toHaveBeenLastCalledWith(null);
  discovery.dispose();
});

it('aborts work when its last terminal closes and never applies replies after disposal', async () => {
  let signal!: AbortSignal;
  let finish!: (value: TerminalPortSnapshot) => void;
  const discovery = new TerminalPortDiscovery((_roots, received) => {
    signal = received;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const receive = jest.fn();
  const stop = discovery.register(1, 10, receive);
  const pending = discovery.refresh();
  await Promise.resolve();
  stop();
  expect(signal.aborted).toBe(true);
  discovery.dispose();
  finish(snapshot(10));
  await pending;
  expect(receive).not.toHaveBeenCalled();
});

it('bounds the lifetime of a collector and removes its deadline after completion', async () => {
  jest.useFakeTimers();
  try {
    const discovery = new TerminalPortDiscovery(
      (_roots, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const receive = jest.fn();
    discovery.register(1, 10, receive);
    const pending = discovery.refresh();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(3500);
    await pending;
    expect(receive).toHaveBeenCalledWith(null);
    expect(jest.getTimerCount()).toBe(0);
    discovery.dispose();
  } finally {
    jest.useRealTimers();
  }
});
