import { EventEmitter } from 'node:events';
import type { CDPSession } from 'playwright-core';
import { RuntimeBrowserCapture } from './runtime-capture.js';

function fixture() {
  const state = {
    width: 800,
    height: 600,
    pixelRatio: 1,
    displayEpoch: 1,
    visible: true,
    ready: true,
  };
  const events = new EventEmitter();
  let image = 'first';
  const send = jest.fn((method: string) =>
    Promise.resolve(
      method === 'Page.captureScreenshot'
        ? { data: Buffer.from(image).toString('base64') }
        : {},
    ),
  );
  const cdp = Object.assign(events, { send });
  const capture = new RuntimeBrowserCapture(() => ({ ...state }));
  // The fixture implements only the CDP operations owned by the capture boundary.
  capture.attach(cdp as unknown as CDPSession);
  const frame = (value: string) =>
    events.emit('Page.screencastFrame', {
      sessionId: 1,
      data: Buffer.from(value).toString('base64'),
      metadata: { deviceWidth: 800, deviceHeight: 600 },
    });
  return {
    state,
    capture,
    send,
    events,
    frame,
    image: (value: string) => {
      image = value;
    },
  };
}
const settle = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('delivers an initial static image and recovers a missed input update without future damage', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  try {
    const initial = f.capture.next(0, signal);
    await jest.advanceTimersByTimeAsync(0);
    expect((await initial)?.jpeg.toString()).toBe('first');
    f.image('hover');
    f.capture.changed();
    const next = f.capture.next(1, signal);
    await jest.advanceTimersByTimeAsync(0);
    expect((await next)?.jpeg.toString()).toBe('hover');
    const idle = f.capture.next(2, signal, 2500);
    await jest.advanceTimersByTimeAsync(2500);
    expect(await idle).toBeNull();
    expect(
      f.send.mock.calls.filter(
        ([method]) => method === 'Page.captureScreenshot',
      ).length,
    ).toBeLessThanOrEqual(4);
  } finally {
    f.capture.detach();
    await f.capture.stop();
  }
});

it('accepts a single damage event before the start reply and never decimates sparse hover changes', async () => {
  const f = fixture();
  const original = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (method) => {
    if (method === 'Page.startScreencast') f.frame('early');
    return original(method);
  });
  try {
    expect(
      (await f.capture.next(0, new AbortController().signal))?.jpeg.toString(),
    ).toBe('early');
    expect(f.send).toHaveBeenCalledWith(
      'Page.startScreencast',
      expect.objectContaining({ everyNthFrame: 1 }),
    );
    f.frame('hover');
    expect(
      (await f.capture.next(1, new AbortController().signal))?.jpeg.toString(),
    ).toBe('hover');
  } finally {
    f.capture.detach();
    await f.capture.stop();
  }
});

it('keeps a read live through loading and rejects overlapping reads before the waiter exists', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  f.state.ready = false;
  try {
    const first = f.capture.next(0, signal);
    await expect(f.capture.next(0, signal)).rejects.toThrow('already pending');
    await jest.advanceTimersByTimeAsync(200);
    expect(
      f.send.mock.calls.some(([method]) => method === 'Page.captureScreenshot'),
    ).toBe(false);
    f.state.ready = true;
    await f.capture.start();
    await jest.advanceTimersByTimeAsync(100);
    expect((await first)?.displayEpoch).toBe(1);
  } finally {
    f.capture.detach();
    await f.capture.stop();
  }
});

it('cancels only the owning waiter and restarts after an interrupted asynchronous start', async () => {
  const f = fixture(),
    controller = new AbortController();
  let release!: () => void;
  const start = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.send.getMockImplementation()!;
  let held = false;
  f.send.mockImplementation(async (method) => {
    if (method === 'Page.startScreencast' && !held) {
      held = true;
      await start;
    }
    return original(method);
  });
  try {
    const old = f.capture.next(0, controller.signal);
    await settle();
    f.state.displayEpoch++;
    f.capture.invalidate();
    f.frame('stale');
    release();
    expect(await old).toBeNull();
    const next = f.capture.next(0, new AbortController().signal);
    await settle();
    controller.abort();
    f.frame('current');
    expect(await next).toMatchObject({
      displayEpoch: 2,
      jpeg: Buffer.from('current'),
    });
    expect(
      f.send.mock.calls.filter(([method]) => method === 'Page.startScreencast'),
    ).toHaveLength(2);
  } finally {
    release();
    f.capture.detach();
    await f.capture.stop();
  }
  expect(f.events.listenerCount('Page.screencastFrame')).toBe(0);
});

it('discards a screenshot completed after hide/show and stops watchdog work on abort', async () => {
  const f = fixture(),
    controller = new AbortController();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.send.getMockImplementation()!;
  let held = false;
  f.send.mockImplementation(async (method) => {
    if (method === 'Page.captureScreenshot' && !held) {
      held = true;
      await pending;
      return { data: Buffer.from('old-hidden-page').toString('base64') };
    }
    return original(method);
  });
  try {
    const old = f.capture.next(0, controller.signal);
    await jest.advanceTimersByTimeAsync(0);
    f.state.visible = false;
    f.capture.invalidate();
    expect(await old).toBeNull();
    f.state.visible = true;
    const next = f.capture.next(0, controller.signal);
    await settle();
    release();
    await settle();
    await jest.advanceTimersByTimeAsync(100);
    expect((await next)?.jpeg.toString()).toBe('first');
    const aborted = f.capture.next(1, controller.signal);
    await settle();
    controller.abort();
    expect(await aborted).toBeNull();
    const count = f.send.mock.calls.length;
    await jest.advanceTimersByTimeAsync(5000);
    expect(f.send.mock.calls).toHaveLength(count);
  } finally {
    release();
    f.capture.detach();
    await f.capture.stop();
  }
});
