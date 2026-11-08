import type { CDPSession, Page } from 'playwright-core';
import { RuntimeBrowserInput } from './runtime-input.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const settle = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const relative = {
  kind: 'pointer-relative' as const,
  deltaX: 3,
  deltaY: -2,
  buttons: 0,
  modifiers: 0,
  pointerLockEpoch: 2,
};
const key = {
  kind: 'key' as const,
  type: 'down' as const,
  key: 'a',
  code: 'KeyA',
  keyCode: 65,
  modifiers: 0,
};

function fixture() {
  const commands: { method: string; params: unknown }[] = [],
    receipts: ReturnType<typeof deferred>[] = [];
  const send = jest.fn(async (method: string, params: unknown) => {
    commands.push({ method, params });
    const receipt = deferred();
    receipts.push(receipt);
    await receipt.promise;
  });
  const frames = jest.fn(() => {
    throw new Error('Motion must not enumerate frames');
  });
  const state = {
    epoch: 2,
    locked: true,
    settled: () => Promise.resolve(),
    assert(epoch: number) {
      if (!state.locked || epoch !== state.epoch)
        throw new Error('Pointer lock ended');
    },
    unlock(epoch?: number) {
      if (epoch === undefined || epoch === state.epoch) {
        state.locked = false;
        state.epoch++;
      }
    },
  };
  // Deliberately minimal platform fixtures: only the adapter's public inputs
  // are exercised, and any accidental frame scan fails the test.
  const input = new RuntimeBrowserInput(
    { frames, isClosed: () => false } as unknown as Page,
    { send } as unknown as CDPSession,
    state,
  );
  return { input, state, commands, receipts, frames };
}

it('pipelines relative movement with exact accumulated deltas and keeps keys behind every receipt', async () => {
  const { input, receipts, commands, frames } = fixture();
  const moves = Array.from({ length: 4 }, () =>
    input.dispatch(relative, () => undefined),
  );
  const keyboard = input.dispatch(key, () => undefined);
  await settle();
  expect(commands.map((command) => command.params)).toEqual(
    [1, 2, 3, 4].map((n) => ({
      type: 'mouseMoved',
      x: 3 * n,
      y: -2 * n,
      buttons: 0,
      modifiers: 0,
    })),
  );
  for (const i of [2, 0, 3]) {
    receipts[i].resolve();
    await settle();
  }
  expect(commands).toHaveLength(4);
  receipts[1].resolve();
  await settle();
  expect(commands[4]?.method).toBe('Input.dispatchKeyEvent');
  receipts[4].resolve();
  await Promise.all([...moves, keyboard]);
  expect(frames).not.toHaveBeenCalled();
  input.destroy();
});

it('binds queued motion to its admission lease even for legacy events without an epoch', async () => {
  const { input, receipts, commands, state } = fixture();
  const blocked = input.dispatch(key, () => undefined);
  const legacy = {
    kind: relative.kind,
    deltaX: 3,
    deltaY: -2,
    buttons: 0,
    modifiers: 0,
  };
  const stale = input.dispatch(legacy, () => undefined);
  const rejected = expect(stale).rejects.toThrow('Pointer lock ended');
  await settle();
  state.epoch += 2;
  receipts[0].resolve();
  await blocked;
  await rejected;
  expect(commands).toHaveLength(1);
  input.destroy();
});

it('keeps ordinary mouse input behind native unlock completion', async () => {
  const { input, state, commands, receipts } = fixture();
  const exit = deferred();
  state.settled = () => exit.promise;
  const moving = input.dispatch(
    {
      kind: 'pointer',
      type: 'move',
      x: 40,
      y: 50,
      button: 'none',
      buttons: 0,
      clicks: 0,
      modifiers: 0,
    },
    () => undefined,
  );
  await settle();
  expect(commands).toHaveLength(0);
  exit.resolve();
  await settle();
  expect(commands).toHaveLength(1);
  receipts[0].resolve();
  await moving;
  input.destroy();
});

it('revokes future motion after a native failure without replaying uncertain movement', async () => {
  const { input, receipts, commands, state } = fixture();
  const first = input.dispatch(relative, () => undefined);
  const rejected = expect(first).rejects.toThrow('native failure');
  await settle();
  receipts[0].reject(new Error('native failure'));
  await rejected;
  expect(state.locked).toBe(false);
  await expect(input.dispatch(relative, () => undefined)).rejects.toThrow(
    'Pointer lock ended',
  );
  expect(commands).toHaveLength(1);
  input.destroy();
});
