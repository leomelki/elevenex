import {
  SESSION_CHAT_TURN_WORK_MAX_LIMIT,
  type BackendResult, type SessionChatItem, type SessionChatRecord, type SessionChatTurnWorkPage,
  type SessionChatTurnWorkRead, type SessionChatTurnWorkReply,
} from '@elevenex/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { completedTurnRecords, SessionChatTurnWork, SessionChatWorkCache } from './session-chat-turn-work';

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
function page(turnId = 'turn', offset = 0, version = revision, total = 2, count = total - offset): SessionChatTurnWorkPage {
  return {
    taskId: selection.taskId, sessionId: selection.sessionId, turnId, offset, revision: version, total,
    items: Array.from({ length: count }, (_, index) => row(turnId + '-' + (offset + index))),
    nextOffset: offset + count < total ? offset + count : null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}
async function settle() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}
function setup(tools?: ConstructorParameters<typeof SessionChatTurnWork>[2]) {
  const client = {
    cancel: vi.fn<(scope: string, id: string) => void>(),
    turnWork: vi.fn(async (_scope: string, input: SessionChatTurnWorkRead): Promise<BackendResult<SessionChatTurnWorkReply>> =>
      ({ ok: true, value: page(input.turnId, input.offset, input.revision) })),
  };
  const work = new SessionChatTurnWork(client, new SessionChatWorkCache(), tools);
  work.select(selection);
  work.sync([turn(), turn('another')], true);
  return { work, client };
}

afterEach(() => vi.useRealTimers());

describe('finished turn activity', () => {
  it('coalesces intent with a click, retains closing rows, and reopens from the complete cache', async () => {
    vi.useFakeTimers();
    const { work, client } = setup();
    work.hint('turn');
    work.hint('another');
    expect(work.open().size).toBe(0);
    work.toggle('turn', true);
    expect(client.turnWork).toHaveBeenCalledOnce();
    expect(work.open().get('turn')).toMatchObject({ busy: true });
    await settle();
    expect(work.open().get('turn')?.items).toEqual(page().items);
    work.toggle('turn', false);
    expect(work.open().get('turn')?.closing).toBe(true);
    work.toggle('turn', true);
    expect(work.open().get('turn')?.items).toEqual(page().items);
    work.toggle('turn', false);
    vi.advanceTimersByTime(300);
    expect(work.open().has('turn')).toBe(false);
    work.toggle('turn', true);
    expect(work.open().get('turn')?.items).toEqual(page().items);
    expect(client.turnWork).toHaveBeenCalledOnce();
  });

  it('assembles older engine pages before publishing the first or last row', async () => {
    const { work, client } = setup();
    const last = deferred<BackendResult<SessionChatTurnWorkPage>>();
    work.sync([turn('turn', 105)], true);
    client.turnWork
      .mockResolvedValueOnce({ ok: true, value: page('turn', 0, revision, 105, 40) })
      .mockResolvedValueOnce({ ok: true, value: page('turn', 40, revision, 105, 40) })
      .mockReturnValueOnce(last.promise);
    work.toggle('turn', true);
    await settle();
    expect(client.turnWork.mock.calls.map(([, input]) => input.offset)).toEqual([0, 40, 80]);
    expect(new Set(client.turnWork.mock.calls.map(([, input]) => input.requestId)).size).toBe(1);
    expect(client.turnWork).toHaveBeenCalledWith(selection.scopeId, expect.objectContaining({
      deferToolDetails: true, limit: SESSION_CHAT_TURN_WORK_MAX_LIMIT, timeline: true,
    }));
    expect(work.open().get('turn')?.items).toBeUndefined();
    last.resolve({ ok: true, value: page('turn', 80, revision, 105) });
    await settle();
    expect(work.open().get('turn')?.items).toEqual(page('turn', 0, revision, 105).items);
    expect(work.open().get('turn')?.busy).toBeUndefined();
  });

  it('assembles compact batches in source order when paired results straddle the reply', async () => {
    const { work, client } = setup();
    const saved = turn('turn', 5);
    const summary = { ...saved.completedTurn!, beforeReply: 3 };
    work.sync([{ ...saved, completedTurn: summary }], true);
    const first = { taskId: selection.taskId, sessionId: selection.sessionId, turnId: 'turn', revision,
      offset: 0, total: 5, nextOffset: 3 };
    const last = deferred<BackendResult<SessionChatTurnWorkReply>>();
    client.turnWork.mockResolvedValueOnce({ ok: true, value: { ...first, timeline: [
      { kind: 'call', id: 'call', toolKind: 'bash', label: 'pnpm test', resultId: 'receipt' },
      { kind: 'call', id: 'read', toolKind: 'read', label: 'src/test.ts', resultId: 'read-result' },
      null,
    ] } }).mockReturnValueOnce(last.promise);
    work.toggle('turn', true);
    await settle();
    expect(client.turnWork.mock.calls.map(([, input]) => input.offset)).toEqual([0, 3]);
    expect(work.open().get('turn')?.items).toBeUndefined();
    last.resolve({ ok: true, value: { ...first, offset: 3, nextOffset: null, timeline: [null, row('after', 'system')] } });
    await settle();
    const opened = work.open().get('turn');
    expect(completedTurnRecords(summary, opened).map(record => record.id)).toEqual(['call', 'read', 'turn-reply', 'after']);
    expect(opened?.items?.[0]).toMatchObject({ kind: 'tool_use', toolDetails: { revision, summary: 'pnpm test' },
      receipt: { id: 'receipt', toolDetails: { revision } } });
  });

  it('cancels a closing or superseded turn and rejects replies from those reads', async () => {
    const { work, client } = setup();
    const held = deferred<BackendResult<SessionChatTurnWorkPage>>();
    client.turnWork.mockReturnValueOnce(held.promise);
    work.toggle('turn', true);
    const pending = client.turnWork.mock.calls[0]![1];
    work.toggle('turn', false);
    expect(client.cancel).toHaveBeenCalledWith(selection.scopeId, pending.requestId);
    held.resolve({ ok: true, value: page() });
    await settle();
    expect(work.open().size).toBe(0);
    work.toggle('turn', true);
    const replacement = 'b'.repeat(64);
    work.sync([turn('turn', 2, replacement)], true);
    await settle();
    expect(work.open().get('turn')).toMatchObject({ revision: replacement, items: page('turn', 0, replacement).items });
    expect(client.turnWork).toHaveBeenCalledTimes(3);
    work.select({ ...selection, sessionId: 102 });
    expect(work.open().size).toBe(0);
  });

  it.each(['wrong session', 'duplicate item', 'non-advancing cursor'])('retries the whole turn after a later batch has a %s', async issue => {
    const { work, client } = setup();
    const last = page('turn', 1);
    client.turnWork
      .mockResolvedValueOnce({ ok: true, value: page('turn', 0, revision, 2, 1) })
      .mockResolvedValueOnce({ ok: true, value: issue === 'wrong session' ? { ...last, sessionId: 102 } :
        issue === 'duplicate item' ? { ...last, items: [row('turn-0')] } : { ...last, nextOffset: 1 } });
    work.toggle('turn', true);
    await settle();
    expect(work.open().get('turn')?.items).toBeUndefined();
    expect(work.open().get('turn')?.error).toBe('failed');
    work.retry('turn');
    await settle();
    expect(client.turnWork.mock.calls.map(([, input]) => input.offset)).toEqual([0, 1, 0]);
    expect(work.open().get('turn')?.items).toEqual(page().items);
  });

  it('silently resumes an interrupted disclosure when the conversation becomes available', async () => {
    const { work, client } = setup();
    client.turnWork.mockReturnValueOnce(new Promise(() => undefined));
    work.toggle('turn', true);
    work.pause();
    expect(client.cancel).toHaveBeenCalledOnce();
    expect(work.open().get('turn')?.busy).toBeUndefined();
    expect(work.open().get('turn')?.error).toBeUndefined();
    work.sync([turn()], true);
    await settle();
    expect(work.open().get('turn')?.items).toEqual(page().items);
  });

  it('waits for already-open tool details and retains their inspections through the reveal', async () => {
    const first = deferred<void>();
    const prepare = vi.fn<(items: readonly SessionChatRecord[], ids: readonly string[], signal: AbortSignal) => Promise<void>>(
      () => first.promise,
    );
    const afterReveal = vi.fn<(release: () => void) => void>();
    const { work, client } = setup({ prepare, afterReveal });
    work.toggle('turn', true, ['turn-1']);
    await settle();
    expect(prepare).toHaveBeenCalledWith(page().items, ['turn-1'], expect.any(AbortSignal), undefined);
    expect(work.open().get('turn')?.items).toBeUndefined();
    const signal = prepare.mock.calls[0]![2];
    first.resolve();
    await settle();
    expect(work.open().get('turn')?.items).toEqual(page().items);
    expect(signal.aborted).toBe(false);
    afterReveal.mock.calls[0]![0]();
    expect(signal.aborted).toBe(true);
    expect(client.turnWork).toHaveBeenCalledOnce();
  });

  it('drops cached turns by least recent access, aggregate bytes, and backend scope', () => {
    const cache = new SessionChatWorkCache();
    for (let index = 0; index < 16; index++) cache.put(selection, 'turn-' + index, revision, { items: [row('small')] });
    expect(cache.get(selection, 'turn-0', revision)).toBeDefined();
    cache.put(selection, 'turn-16', revision, { items: [row('small')] });
    expect(cache.get(selection, 'turn-1', revision)).toBeUndefined();
    expect(cache.get(selection, 'turn-0', revision)).toBeDefined();

    for (let index = 0; index < 6; index++) {
      const id = 'large-' + index;
      cache.put(selection, id, revision, { items: [row(id, 'thinking', 'é'.repeat(170_000))] });
    }
    expect(cache.get(selection, 'large-0', revision)).toBeUndefined();
    expect(cache.get(selection, 'large-5', revision)).toBeDefined();
    expect(cache.get({ ...selection, scopeId: 'rebound' }, 'large-5', revision)).toBeUndefined();
    expect(cache.get(selection, 'large-5', revision)).toBeUndefined();
  });
});
