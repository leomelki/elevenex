import type { Page } from 'playwright-core';
import { RuntimeBrowserCursor } from './runtime-cursor.js';

function fixture() {
  const evaluate = jest
    .fn<Promise<string>, [unknown, { x: number; y: number }]>()
    .mockResolvedValue('pointer');
  const publish = jest.fn();
  // Only the page evaluation boundary belongs to the cursor reader.
  const cursor = new RuntimeBrowserCursor(
    { evaluate } as unknown as Page,
    publish,
  );
  return { cursor, evaluate, publish };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('coalesces motion and keeps a single optional page read in flight', async () => {
  const f = fixture();
  let finish!: (cursor: string) => void;
  f.evaluate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    f.cursor.update(1, 1, () => true);
    f.cursor.update(2, 2, () => true);
    await jest.advanceTimersByTimeAsync(32);
    expect(f.evaluate).toHaveBeenCalledTimes(1);
    expect(f.evaluate.mock.calls[0][1]).toEqual({ x: 2, y: 2 });
    for (let x = 3; x <= 100; x++) f.cursor.update(x, 10, () => true);
    await jest.advanceTimersByTimeAsync(500);
    expect(f.evaluate).toHaveBeenCalledTimes(1);
    finish('crosshair');
    await jest.advanceTimersByTimeAsync(32);
    expect(f.evaluate).toHaveBeenCalledTimes(2);
    expect(f.evaluate.mock.calls[1][1]).toEqual({ x: 100, y: 10 });
    expect(f.publish.mock.calls).toEqual([['pointer']]);
  } finally {
    f.cursor.destroy();
  }
});

it('discards late metadata after document, presentation or authority changes', async () => {
  const f = fixture();
  let current = true,
    finish!: (cursor: string) => void;
  f.evaluate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    f.cursor.update(10, 20, () => current);
    await jest.advanceTimersByTimeAsync(32);
    current = false;
    finish('crosshair');
    await jest.advanceTimersByTimeAsync(32);
    expect(f.publish).not.toHaveBeenCalled();
    f.cursor.update(10, 20, () => true);
    f.cursor.reset();
    await jest.advanceTimersByTimeAsync(100);
    expect(f.evaluate).toHaveBeenCalledTimes(1);
    f.cursor.update(10, 20, () => true);
    await jest.advanceTimersByTimeAsync(32);
    expect(f.publish).toHaveBeenCalledWith('pointer');
  } finally {
    f.cursor.destroy();
  }
});

it('handles failed reads, allows only cursor keywords and cleans up pending work', async () => {
  const f = fixture();
  let finish!: (cursor: string) => void;
  try {
    f.evaluate.mockRejectedValueOnce(new Error('Document replaced'));
    f.cursor.update(10, 20, () => true);
    await jest.advanceTimersByTimeAsync(32);
    expect(f.publish).not.toHaveBeenCalled();
    f.evaluate.mockResolvedValueOnce(
      'url(https://private.example/cursor), pointer',
    );
    f.cursor.update(10, 20, () => true);
    await jest.advanceTimersByTimeAsync(32);
    expect(f.publish.mock.calls).toEqual([['default']]);
    f.evaluate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    f.cursor.update(10, 20, () => true);
    await jest.advanceTimersByTimeAsync(32);
    f.cursor.update(30, 40, () => true);
    f.cursor.destroy();
    finish('crosshair');
    await jest.advanceTimersByTimeAsync(1000);
    expect(f.evaluate).toHaveBeenCalledTimes(3);
    expect(f.publish.mock.calls).toEqual([['default']]);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    f.cursor.destroy();
  }
});
