import { BrowserHumanMailbox } from './browser-human-mailbox.js';
import type { BrowserHumanRequest } from '@elevenex/shared';

const request = (): BrowserHumanRequest => ({
  id: 'request',
  sessionId: 2,
  tabId: 'tab',
  kind: 'element',
  message: 'Choose the item',
  status: 'pending',
  expiresAt: Date.now() + 600000,
});
describe('Task browser human request mailbox', () => {
  let mailbox: BrowserHumanMailbox;
  beforeEach(() => {
    mailbox = new BrowserHumanMailbox();
  });
  afterEach(() => {
    mailbox.dispose();
    jest.useRealTimers();
  });
  it('pins tickets and results to the authenticated task, session and host', async () => {
    const ticket = request();
    mailbox.register(1, 2, 'host', [ticket]);
    expect(() => mailbox.get(1, 3, ticket.id)).toThrow();
    expect(() => mailbox.get(4, 2, ticket.id)).toThrow();
    expect(() => mailbox.register(4, 2, 'host', [ticket])).toThrow();
    const done = { ...ticket, status: 'completed' as const };
    mailbox.update(1, 'wrong-host', [done]);
    expect(mailbox.get(1, 2, ticket.id).value.status).toBe('pending');
    mailbox.update(1, 'host', [{ ...done, sessionId: 3 }]);
    expect(mailbox.get(1, 2, ticket.id).value.status).toBe('pending');
    const waiting = mailbox.wait(
      1,
      2,
      ticket.id,
      1000,
      new AbortController().signal,
    );
    mailbox.update(1, 'host', [done]);
    await expect(waiting).resolves.toEqual(done);
    mailbox.update(1, 'host', [ticket]);
    expect(mailbox.get(1, 2, ticket.id).value.status).toBe('completed');
  });
  it('withholds a selection until confirmation, including cancellation and expiry', () => {
    const ticket = request();
    mailbox.register(1, 2, 'host', [ticket]);
    const selection = {
      selector: 'button',
      tag: 'button',
      frames: [],
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      documentId: 'doc',
    };
    mailbox.update(1, 'host', [{ ...ticket, selection }]);
    expect(mailbox.get(1, 2, ticket.id).value.selection).toBeUndefined();
    mailbox.update(1, 'host', [{ ...ticket, status: 'cancelled', selection }]);
    expect(mailbox.get(1, 2, ticket.id).value.selection).toBeUndefined();
  });
  it('cancels or disconnects a wait without cancelling or replaying the human request', async () => {
    const ticket = request();
    mailbox.register(1, 2, 'host', [ticket]);
    const controller = new AbortController();
    const cancelled = mailbox.wait(1, 2, ticket.id, 1000, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toThrow('remains pending');
    const disconnected = mailbox.wait(
      1,
      2,
      ticket.id,
      1000,
      new AbortController().signal,
    );
    mailbox.disconnected('host');
    await expect(disconnected).rejects.toThrow('disconnected');
    expect(mailbox.get(1, 2, ticket.id).value.status).toBe('pending');
  });
  it('bounds concurrent waiters, resolves on expiry and cleans up timers', async () => {
    jest.useFakeTimers();
    const ticket = { ...request(), expiresAt: Date.now() + 20 };
    mailbox.register(1, 2, 'host', [ticket]);
    const waits = Array.from({ length: 4 }, () =>
      mailbox.wait(1, 2, ticket.id, 1000, new AbortController().signal),
    );
    await expect(
      mailbox.wait(1, 2, ticket.id, 1000, new AbortController().signal),
    ).rejects.toThrow('Too many');
    jest.advanceTimersByTime(25);
    mailbox.sweep();
    expect(
      (await Promise.all(waits)).every((value) => value.status === 'expired'),
    ).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });
});
