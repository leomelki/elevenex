import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { BadRequestException } from '@nestjs/common';
import * as schema from '../database/schema/index.js';
import { SessionPromptReceipts } from '../sessions/session-prompt-receipts.js';
import { desktopChatDeliveryKey, trackDesktopChatDelivery } from './desktop-chat-delivery.js';

function setup() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve(__dirname, '../../drizzle') });
  // This test owns only the ledger; the route verifies task/session membership.
  sqlite.pragma('foreign_keys = OFF');
  return { sqlite, receipts: new SessionPromptReceipts(db, () => undefined) };
}

it.each(['queued', 'running'] as const)('records %s acceptance independently of a lost reply and never repeats dispatch', async disposition => {
  const { sqlite, receipts } = setup();
  try {
    const id = randomUUID(), key = desktopChatDeliveryKey(2, id);
    let release!: () => void;
    const pending = new Promise<void>(done => { release = done; });
    const run = jest.fn(async (dispatch?: () => void, onAccepted?: (value: typeof disposition) => void) => {
      dispatch?.();
      await pending;
      onAccepted?.(disposition);
      throw new Error('Late transport or configuration failure');
    });
    const send = trackDesktopChatDelivery(receipts, 2, id, ['Identical text'], run);
    expect(receipts.find(key)?.delivery).toBe('dispatching');
    await expect(trackDesktopChatDelivery(receipts, 2, id, ['Identical text'], run)).rejects.toThrow(/unconfirmed/);
    release();
    await send;
    expect(receipts.find(key)).toMatchObject({ delivery: 'accepted', disposition });
    expect(receipts.find(desktopChatDeliveryKey(3, id))).toBeUndefined();
    await trackDesktopChatDelivery(receipts, 2, id, ['Identical text'], run);
    await expect(trackDesktopChatDelivery(receipts, 2, id, ['Slightly different text'], run)).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
    await trackDesktopChatDelivery(receipts, 2, randomUUID(), ['Identical text'], run);
    expect(run).toHaveBeenCalledTimes(2);
  } finally {
    sqlite.close();
  }
});

it('distinguishes explicit rejection from an interrupted provider handoff', async () => {
  const { sqlite, receipts } = setup();
  try {
    const rejected = randomUUID(), interrupted = randomUUID(), interruptedKey = desktopChatDeliveryKey(2, interrupted);
    await expect(trackDesktopChatDelivery(receipts, 2, rejected, ['A'], async () => {
      throw new BadRequestException('Rejected');
    })).rejects.toThrow('Rejected');
    await expect(trackDesktopChatDelivery(receipts, 2, interrupted, ['B'], async dispatch => {
      dispatch?.();
      throw new BadRequestException('A provider-side error after handoff');
    })).rejects.toThrow(/unconfirmed/);
    const crashed = { id: randomUUID(), key: desktopChatDeliveryKey(2, randomUUID()), fingerprint: 'legacy', sessionId: 2, delivery: 'dispatching' as const };
    receipts.reserve(crashed);
    receipts.recover();
    expect(receipts.find(crashed.key)?.delivery).toBe('unconfirmed');
    expect(receipts.find(interruptedKey)?.delivery).toBe('unconfirmed');
    expect(receipts.find(desktopChatDeliveryKey(2, rejected))?.delivery).toBe('failed');
  } finally {
    sqlite.close();
  }
});

it('requires the provider acceptance callback even if submission returns normally', async () => {
  const { sqlite, receipts } = setup();
  try {
    const id = randomUUID();
    await expect(trackDesktopChatDelivery(receipts, 2, id, ['Stopped before acceptance'], async dispatch => {
      dispatch?.();
    })).rejects.toThrow(/unconfirmed/);
    expect(receipts.find(desktopChatDeliveryKey(2, id))?.delivery).toBe('unconfirmed');
  } finally {
    sqlite.close();
  }
});

it('recovers an interrupted preparation as definitely unsent and fences a late handler', async () => {
  const { sqlite, receipts } = setup();
  try {
    const id = randomUUID(), key = desktopChatDeliveryKey(2, id);
    let release!: () => void;
    const preparation = new Promise<void>(done => { release = done; });
    const nativeSend = jest.fn();
    const sent = trackDesktopChatDelivery(receipts, 2, id, ['Draft'], async beforeDispatch => {
      await preparation;
      beforeDispatch?.();
      nativeSend();
    });
    expect(receipts.find(key)?.delivery).toBe('preparing');
    receipts.recover();
    expect(receipts.find(key)?.delivery).toBe('failed');
    release();
    await expect(sent).rejects.toThrow(/dispatch claim/);
    await expect(trackDesktopChatDelivery(receipts, 2, id, ['Draft'], nativeSend)).rejects.toThrow(/rejected/);
    expect(nativeSend).not.toHaveBeenCalled();
  } finally {
    sqlite.close();
  }
});

it('settles a provider that stops during preparation and emits only the exact durable receipt hint', async () => {
  const { sqlite, receipts } = setup();
  try {
    const id = randomUUID(), settled = jest.fn();
    await expect(trackDesktopChatDelivery(receipts, 2, id, ['Draft'], async () => undefined, settled)).rejects.toThrow(/before the message/);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith(id);
    expect(receipts.find(desktopChatDeliveryKey(2, id))?.delivery).toBe('failed');
    const another = randomUUID();
    await trackDesktopChatDelivery(receipts, 2, another, ['A second draft'], async (begin, accepted) => {
      begin?.();
      accepted?.('running');
      accepted?.('running');
    }, settled);
    expect(settled.mock.calls).toEqual([[id], [another]]);
  } finally {
    sqlite.close();
  }
});
