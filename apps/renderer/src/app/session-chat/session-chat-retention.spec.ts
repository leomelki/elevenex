import { describe, expect, it } from 'vitest';
import type { SessionChatItem, SessionChatState } from '@elevenex/shared';
import { CHAT_RETAINED_BYTES, CHAT_RETAINED_ITEMS, chatItemBytes, retainChatItems } from './session-chat-retention';
import { ChatTranscriptProjection, chatExchanges } from './session-chat-transcript';
import { SessionChatDrafts, type ChatSnapshot } from './session-chat-drafts';

const item = (id: string, text = 'Hello', kind: SessionChatItem['kind'] = 'assistant'): SessionChatItem => ({
  id, text, kind, timestamp: '2026-11-15T12:00:00Z', toolId: null, toolName: null, toolKind: null, input: '', error: false, truncated: false,
});
const state: SessionChatState = {
  provider: 'codex', phase: 'idle', canInterrupt: false, error: null, model: null, models: [], reasoning: null, plan: false, permissionMode: null, permissionModes: [], context: null, queue: [], queuePaused: false, permission: null, question: null, activity: [],
};

describe('transcript retention budgets', () => {
  it('retains a contiguous range within both item and byte budgets in either direction', () => {
    for (const items of [Array.from({ length: 9000 }, (_, i) => item(String(i))), Array.from({ length: 1000 }, (_, i) => item(String(i), '😀'.repeat(8000)))]) {
      for (const older of [true, false]) {
        const retained = retainChatItems(items, older);
        expect(retained.length).toBeLessThanOrEqual(CHAT_RETAINED_ITEMS);
        expect(retained.reduce((sum, item) => sum + chatItemBytes(item), 0)).toBeLessThanOrEqual(CHAT_RETAINED_BYTES);
        expect(retained).toEqual(older ? items.slice(0, retained.length) : items.slice(-retained.length));
      }
    }
  });

  it('evicts snapshots by total memory and clears history on a different machine', () => {
    const drafts = new SessionChatDrafts(); drafts.entry('one', 1);
    const snapshot = (id: string): ChatSnapshot => ({ items: [item(id, 'x'.repeat(5 * 1024 * 1024))], state, before: null, next: null, supportsFollowing: true });
    drafts.remember(1, snapshot('1')); drafts.remember(2, snapshot('2'));
    expect(drafts.snapshot(1)).toBeDefined();
    drafts.remember(3, snapshot('3'));
    expect(drafts.snapshot(2)).toBeUndefined(); expect(drafts.snapshot(1)).toBeDefined();
    drafts.entry('two', 1);
    expect(drafts.snapshot(1)).toBeUndefined();
  });
});

it('reuses completed projections during streaming and releases evicted turns', () => {
  const projection = new ChatTranscriptProjection(), fresh = new Set<string>();
  const initial = [item('u1', 'One', 'user'), item('a1'), item('u2', 'Two', 'user'), item('a2', 'Part')];
  const running = { ...state, phase: 'running' as const };
  const first = projection.project(initial, running, fresh);
  expect(first).toEqual(chatExchanges(initial, running, fresh));
  const changed = [...initial.slice(0, -1), item('a2', 'Part two')];
  const second = projection.project(changed, running, fresh);
  expect(second[0]).toBe(first[0]); expect(second[1]).not.toBe(first[1]);
  expect(second).toEqual(chatExchanges(changed, running, fresh));
  projection.project([], null, fresh);
  expect(projection.project(initial, running, fresh)[0]).not.toBe(first[0]);
});
