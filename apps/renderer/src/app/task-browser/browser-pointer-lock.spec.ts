import { afterEach, expect, it, vi } from 'vitest';
import { BrowserPointerLock } from './browser-pointer-lock';

afterEach(() => {
  Reflect.deleteProperty(document, 'pointerLockElement');
  Reflect.deleteProperty(document, 'exitPointerLock');
});

function fixture() {
  let element: Element | null = null;
  Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => element });
  const exit = vi.fn(() => { element = null; });
  Object.defineProperty(document, 'exitPointerLock', { configurable: true, value: exit });
  const canvas = document.createElement('canvas'), send = vi.fn();
  const lock = new BrowserPointerLock(send);
  return { canvas, send, lock, exit, grant: () => {
    element = canvas; document.dispatchEvent(new Event('pointerlockchange'));
  } };
}

it('releases exactly the host acquisition for which the user granted local pointer lock', async () => {
  const { canvas, send, lock, grant } = fixture();
  canvas.requestPointerLock = vi.fn(async () => grant());
  try {
    await lock.start(canvas, 7); expect(lock.locked()).toBe(true); expect(lock.epoch).toBe(7);
    lock.release(); expect(send).toHaveBeenCalledExactlyOnceWith({ kind: 'pointer-unlock', pointerLockEpoch: 7 });
    await lock.start(canvas, 9); lock.release();
    expect(send.mock.lastCall?.[0]).toEqual({ kind: 'pointer-unlock', pointerLockEpoch: 9 });
  } finally { lock.destroy(); }
});

it('keeps legacy hosts on their original unlock contract', async () => {
  const { canvas, send, lock, grant } = fixture();
  canvas.requestPointerLock = vi.fn(async () => grant());
  try { await lock.start(canvas); lock.release(); expect(send).toHaveBeenCalledExactlyOnceWith({ kind: 'pointer-unlock' }); }
  finally { lock.destroy(); }
});

it('does not let an old grant completion release a newer request on the same canvas', async () => {
  const { canvas, lock, grant, exit } = fixture();
  let finish!: () => void;
  canvas.requestPointerLock = vi.fn().mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; })).mockImplementationOnce(async () => grant());
  try {
    const old = lock.start(canvas, 7); lock.release();
    await lock.start(canvas, 9); finish(); await old;
    expect(lock.locked()).toBe(true); expect(lock.epoch).toBe(9); expect(exit).not.toHaveBeenCalled();
  } finally { lock.destroy(); }
});
