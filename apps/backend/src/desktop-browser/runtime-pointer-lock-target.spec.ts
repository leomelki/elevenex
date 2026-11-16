import { EventEmitter } from 'node:events';
import type { CDPSession } from 'playwright-core';
import {
  PointerLockTarget,
  type PointerLockContext,
} from './runtime-pointer-lock-target.js';

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function fixture() {
  const events = new EventEmitter(),
    report = jest.fn<void, [PointerLockContext, boolean, boolean]>(),
    removed = jest.fn<void, [PointerLockContext]>();
  const authorizations = new Map<string, string>();
  const send = jest.fn(
    (
      method: string,
      params?: { expression?: string; uniqueContextId?: string },
    ) => {
      // Capture the challenge sent to the isolated context, not private tracker state.
      if (
        method === 'Runtime.evaluate' &&
        params?.expression?.includes('Authorize"]')
      ) {
        const ticket = params.expression.match(/\]\("([a-f0-9-]{36})"\)$/)?.[1];
        if (ticket && params.uniqueContextId)
          authorizations.set(params.uniqueContextId, ticket);
      }
      return Promise.resolve({ identifier: 'script' });
    },
  );
  const detach = jest.fn(() => Promise.resolve());
  // A CDP protocol fixture implements the consumed platform boundary; production
  // uses Playwright's typed session directly.
  const cdp = Object.assign(events, { send, detach }) as unknown as CDPSession;
  const target = new PointerLockTarget(
    cdp,
    true,
    'private-world',
    'private-binding',
    report,
    removed,
    jest.fn(),
  );
  const create = (uniqueId: string, name = 'private-world') =>
    events.emit('Runtime.executionContextCreated', {
      context: { id: 1, uniqueId, name, auxData: { frameId: 'frame' } },
    });
  const notify = (
    uniqueId: string,
    sequence: number,
    extra: Record<string, unknown> = {},
  ) =>
    events.emit('Runtime.bindingCalled', {
      name: 'private-binding',
      executionContextId: 1,
      payload: JSON.stringify({
        locked: true,
        change: true,
        sequence,
        ticket: authorizations.get(uniqueId),
        ...extra,
      }),
    });
  return { target, events, report, removed, send, detach, create, notify };
}

it('accepts only registered isolated contexts, bounded payloads and increasing sequences', async () => {
  const { target, events, report, create, notify } = fixture();
  await target.start();
  create('main', '');
  await settle();
  notify('main', 1);
  expect(report).not.toHaveBeenCalled();
  create('isolated');
  await settle();
  notify('isolated', 1);
  expect(report).toHaveBeenCalledTimes(1);
  notify('isolated', 1);
  notify('isolated', 2, { ticket: 'forged' });
  notify('isolated', 2, { sequence: 1.5 });
  notify('isolated', 2, { locked: 'true' });
  events.emit('Runtime.bindingCalled', {
    name: 'private-binding',
    executionContextId: 1,
    payload: 'x'.repeat(193),
  });
  expect(report).toHaveBeenCalledTimes(1);
  await target.destroy();
  expect(events.listenerCount('Runtime.bindingCalled')).toBe(0);
});

it('rejects old callbacks and destruction notifications after a context ID is reused', async () => {
  const { target, events, report, create, notify, removed } = fixture();
  await target.start();
  create('old');
  await settle();
  notify('old', 1);
  const old = report.mock.calls[0][0];
  create('new');
  await settle();
  notify('old', 99);
  expect(report).toHaveBeenCalledTimes(1);
  expect(removed).toHaveBeenCalledWith(old);
  events.emit('Runtime.executionContextDestroyed', {
    executionContextId: 1,
    executionContextUniqueId: 'old',
  });
  notify('new', 1);
  expect(report).toHaveBeenCalledTimes(2);
  events.emit('Runtime.executionContextDestroyed', {
    executionContextId: 1,
    executionContextUniqueId: 'new',
  });
  notify('new', 2);
  expect(report).toHaveBeenCalledTimes(2);
  await target.destroy();
});

it('does not install an observer after disposal interrupts asynchronous setup', async () => {
  const { target, send, detach } = fixture();
  let finish!: () => void;
  send.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { identifier: 'script' };
  });
  const starting = target.start(),
    rejected = expect(starting).rejects.toThrow('stopped');
  await settle();
  await target.destroy();
  finish();
  await rejected;
  expect(
    send.mock.calls.some(
      ([method]) => method === 'Page.addScriptToEvaluateOnNewDocument',
    ),
  ).toBe(false);
  expect(detach).toHaveBeenCalledTimes(1);
});

it('rotates document tickets even when document.open preserves the execution context', async () => {
  const { target, events, report, create, notify, removed } = fixture();
  await target.start();
  create('same-context');
  await settle();
  notify('same-context', 1);
  const previous = report.mock.calls[0][0];
  events.emit('Page.documentOpened', { frame: { id: 'frame' } });
  await settle();
  events.emit('Runtime.bindingCalled', {
    name: 'private-binding',
    executionContextId: 1,
    payload: JSON.stringify({
      locked: true,
      change: true,
      sequence: 99,
      ticket: previous.ticket,
    }),
  });
  expect(report).toHaveBeenCalledTimes(1);
  expect(removed).toHaveBeenCalledWith(previous);
  notify('same-context', 1);
  expect(report).toHaveBeenCalledTimes(2);
  expect(report.mock.calls[1][0].ticket).not.toBe(previous.ticket);
  await target.destroy();
});
