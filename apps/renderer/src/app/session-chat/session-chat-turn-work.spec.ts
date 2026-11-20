import type { BackendResult, SessionChatItem, SessionChatRecord, SessionChatTurnWorkPage, SessionChatTurnWorkRead } from '@elevenex/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionChatTurnWork, SessionChatWorkCache } from './session-chat-turn-work';

const selection = { taskId: 12, sessionId: 101, scopeId: 'machine' };
const revision = 'a'.repeat(64);
const row = (id: string, kind: SessionChatRecord['kind'] = 'thinking', text = id): SessionChatRecord => ({
  id, kind, text, timestamp: '', toolId: null, toolKind: null, toolName: null, input: '', error: false, truncated: false,
});
const turn = (id = 'turn', total = 2, version = revision): SessionChatItem => ({
  ...row(id, 'user'),
  completedTurn: {
    revision: version, endId: id + '-reply', reply: [row(id + '-reply', 'assistant')],
    beforeReply: total, total, counts: {}, failures: 0,
  },
});
function page(turnId = 'turn', offset = 0, version = revision): SessionChatTurnWorkPage {
  return {
    taskId: selection.taskId, sessionId: selection.sessionId, turnId, offset, revision: version,
    total: 2, items: [row(turnId + '-' + offset)], nextOffset: offset === 0 ? 1 : null,
  };
}
function setup() {
  const client = {
    cancel: vi.fn<(scope: string, id: string) => void>(),
    turnWork: vi.fn(async (_scope: string, input: SessionChatTurnWorkRead): Promise<BackendResult<SessionChatTurnWorkPage>> =>
      ({ ok: true, value: page(input.turnId, input.offset, input.revision) })),
  };
  const work = new SessionChatTurnWork(client, new SessionChatWorkCache());
  work.select(selection);
  work.sync([turn(), turn('another')], true);
  return { work, client };
}

afterEach(() => vi.useRealTimers());

describe('finished turn activity', () => {
  it('coalesces intent with a click, retains the open page, and reopens from the bounded cache', async () => {
    vi.useFakeTimers();
    const { work, client } = setup();
    work.hint('turn');
    work.hint('another');
    expect(work.open().size).toBe(0);
    work.toggle('turn', true);
    expect(client.turnWork).toHaveBeenCalledTimes(1);
    expect(work.open().get('turn')?.requested?.offset).toBe(0);
    await Promise.resolve();
    expect(work.open().get('turn')?.page).toEqual(page());
    work.toggle('turn', false);
    expect(work.open().get('turn')?.closing).toBe(true);
    work.toggle('turn', true);
    expect(work.open().get('turn')?.page).toEqual(page());
    work.toggle('turn', false);
    vi.advanceTimersByTime(300);
    expect(work.open().has('turn')).toBe(false);
    work.toggle('turn', true);
    expect(work.open().get('turn')?.page).toEqual(page());
    expect(client.turnWork).toHaveBeenCalledTimes(1);
  });

  it('cancels closed and superseded activity and rejects late results', async () => {
    const { work, client } = setup();
    let finish!: (value: BackendResult<SessionChatTurnWorkPage>) => void;
    client.turnWork.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    work.toggle('turn', true);
    const pending = client.turnWork.mock.calls[0]![1];
    work.toggle('turn', false);
    expect(client.cancel).toHaveBeenCalledWith(selection.scopeId, pending.requestId);
    finish({ ok: true, value: page() });
    await Promise.resolve();
    expect(work.open().size).toBe(0);
    work.toggle('turn', true);
    const replacement = 'b'.repeat(64);
    work.sync([turn('turn', 2, replacement)], true);
    await Promise.resolve();
    expect(work.open().get('turn')?.page?.revision).toBe(replacement);
    expect(client.turnWork).toHaveBeenCalledTimes(3);
    work.select({ ...selection, sessionId: 102 });
    expect(work.open().size).toBe(0);
  });

  it('retains loaded evidence across a failed page read and returns through the page cache', async () => {
    const { work, client } = setup();
    work.toggle('turn', true);
    await Promise.resolve();
    client.turnWork.mockResolvedValueOnce({ ok: true, value: { ...page('turn', 1), sessionId: 102 } });
    work.navigate('turn', 'next');
    expect(work.open().get('turn')?.page?.offset).toBe(0);
    await Promise.resolve();
    expect(work.open().get('turn')?.error).toBe('failed');
    expect(work.open().get('turn')?.page).toEqual(page());
    work.navigate('turn', 'retry');
    await Promise.resolve();
    expect(work.open().get('turn')?.page?.offset).toBe(1);
    work.navigate('turn', 'previous');
    expect(work.open().get('turn')?.page?.offset).toBe(0);
    expect(client.turnWork).toHaveBeenCalledTimes(3);
    work.pause();
    work.navigate('turn', 'next');
    expect(work.open().get('turn')?.page?.offset).toBe(1);
    expect(client.turnWork).toHaveBeenCalledTimes(3);
  });

  it('drops cached pages by least recent access, aggregate bytes, and backend scope', () => {
    const cache = new SessionChatWorkCache();
    for (let index = 0; index < 16; index++) cache.put(selection, page('turn-' + index));
    expect(cache.get(selection, 'turn-0', revision, 0)).toBeDefined();
    cache.put(selection, page('turn-16'));
    expect(cache.get(selection, 'turn-1', revision, 0)).toBeUndefined();
    expect(cache.get(selection, 'turn-0', revision, 0)).toBeDefined();

    for (let index = 0; index < 6; index++) {
      const id = 'large-' + index;
      cache.put(selection, { ...page(id), items: [row(id, 'thinking', 'é'.repeat(170_000))] });
    }
    expect(cache.get(selection, 'large-0', revision, 0)).toBeUndefined();
    expect(cache.get(selection, 'large-5', revision, 0)).toBeDefined();
    expect(cache.get({ ...selection, scopeId: 'rebound' }, 'large-5', revision, 0)).toBeUndefined();
    expect(cache.get(selection, 'large-5', revision, 0)).toBeUndefined();
  });
});
