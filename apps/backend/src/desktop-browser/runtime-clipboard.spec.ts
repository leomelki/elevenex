import type { Page } from 'playwright-core';
import { RuntimeBrowserClipboard } from './runtime-clipboard.js';
import { RuntimeBrowserInput } from './runtime-input.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const element = {
    asElement: () => undefined,
    dispose: jest.fn(() => Promise.resolve()),
  };
  const frame = {
    evaluateHandle: jest.fn(() => Promise.resolve(element)),
    evaluate: jest.fn(() => Promise.resolve('selection')),
  };
  const page = {
    mainFrame: () => frame,
    isClosed: () => false,
    keyboard: { press: jest.fn(() => Promise.resolve()) },
  };
  return {
    element,
    frame,
    page: page as unknown as Page,
    press: page.keyboard.press,
  };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('bounds a stalled selection read and retains single-flight ownership until its evaluator settles', async () => {
  const f = fixture(),
    pending = deferred<string>();
  f.frame.evaluate.mockReturnValueOnce(pending.promise);
  const clipboard = new RuntimeBrowserClipboard(f.page);
  const read = clipboard.read(() => undefined);
  const rejected = expect(read).rejects.toThrow('clipboard interrupted');
  await jest.advanceTimersByTimeAsync(1000);
  await rejected;
  await expect(clipboard.read(() => undefined)).rejects.toThrow(
    'clipboard is unavailable',
  );
  expect(f.frame.evaluate).toHaveBeenCalledTimes(1);
  pending.resolve('expired text');
  await jest.advanceTimersByTimeAsync(0);
  await expect(clipboard.read(() => undefined)).resolves.toBe('selection');
  clipboard.destroy();
  expect(jest.getTimerCount()).toBe(0);
});

it('disposes handles arriving after cancellation without continuing the frame walk', async () => {
  const f = fixture(),
    pending = deferred<typeof f.element>();
  f.frame.evaluateHandle.mockReturnValueOnce(pending.promise);
  const clipboard = new RuntimeBrowserClipboard(f.page);
  const read = clipboard.read(() => undefined);
  const rejected = expect(read).rejects.toThrow('clipboard interrupted');
  clipboard.destroy();
  await rejected;
  pending.resolve(f.element);
  await jest.advanceTimersByTimeAsync(0);
  expect(f.element.dispose).toHaveBeenCalledTimes(1);
  expect(f.frame.evaluate).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it('releases the ordered lane after an expired cut and never deletes a late selection', async () => {
  const f = fixture(),
    pending = deferred<string>();
  f.frame.evaluate.mockReturnValueOnce(pending.promise);
  const send = jest.fn(() => Promise.resolve());
  const input = new RuntimeBrowserInput(f.page, {
    send,
  } as unknown as ConstructorParameters<typeof RuntimeBrowserInput>[1]);
  const cut = input.dispatch(
    { kind: 'clipboard', operation: 'cut' },
    () => undefined,
  );
  const rejected = expect(cut).rejects.toThrow('clipboard interrupted');
  const wheel = input.dispatch(
    { kind: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 50, modifiers: 0 },
    () => undefined,
  );
  await jest.advanceTimersByTimeAsync(1000);
  await rejected;
  await wheel;
  expect(send).toHaveBeenCalledWith(
    'Input.dispatchMouseEvent',
    expect.objectContaining({ type: 'mouseWheel' }),
  );
  pending.resolve('must not cut');
  await jest.advanceTimersByTimeAsync(0);
  expect(f.press).not.toHaveBeenCalled();
  input.destroy();
});
