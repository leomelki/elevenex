import { describe, expect, it } from 'vitest';
import type { SessionChatItem, SessionChatState } from '@elevenex/shared';
import { ChatTranscriptProjection, chatExchanges } from './session-chat-transcript';

const state: SessionChatState = {
  provider: 'codex', phase: 'running', canInterrupt: true, error: null,
  model: null, models: [], reasoning: null, plan: false, permissionMode: null,
  permissionModes: [], context: null, queue: [], queuePaused: false,
  permission: null, question: null, activity: [],
};
const fresh = new Set<string>();
const item = (id: string, kind: SessionChatItem['kind'], text = '', extra: Partial<SessionChatItem> = {}): SessionChatItem => ({
  id, kind, text, timestamp: '2026-11-18T12:00:00Z', toolId: null,
  toolName: null, toolKind: null, input: '', error: false, truncated: false, ...extra,
});
const tool = (id: string) => item(id, 'tool_use', '', { toolId: id, toolKind: 'bash', input: '{"cmd":"pnpm test"}' });

describe('incremental transcript projection', () => {
  it('keeps completed turns and unchanged tools stable as new calls, results and text arrive', () => {
    const projection = new ChatTranscriptProjection();
    const items = [item('first', 'user', 'Earlier request'), item('reply', 'assistant', 'Finished'),
      item('next', 'user', 'Next request'), tool('a')];
    const first = projection.project(items, state, fresh);
    const secondItems = [...items, tool('b')];
    const second = projection.project(secondItems, state, fresh);
    expect(second[0]).toBe(first[0]);
    expect(second[1]!.steps[0]).toBe(first[1]!.steps[0]);
    const completedItems = [...secondItems, item('result-a', 'tool_result', 'Passed', { toolId: 'a' })];
    const third = projection.project(completedItems, state, fresh);
    expect(third[0]).toBe(first[0]);
    expect(third[1]!.steps[0]).not.toBe(second[1]!.steps[0]);
    expect(third[1]!.steps[0]!.status).toBe('done');
    expect(third[1]!.steps[1]).toBe(second[1]!.steps[1]);
    const streamed = [...completedItems, item('answer', 'assistant', 'The result')];
    const fourth = projection.project(streamed, state, fresh);
    expect(fourth[1]!.steps).toBe(third[1]!.steps);
    expect(fourth).toEqual(chatExchanges(streamed, state, fresh));
  });

  it('ignores unrelated runtime updates and only changes the active turn for phase/decision updates', () => {
    const projection = new ChatTranscriptProjection();
    const items = [item('u1', 'user', 'Earlier'), item('a1', 'assistant', 'Done'),
      item('u2', 'user', 'Latest'), item('a2', 'assistant', 'Streaming')];
    const first = projection.project(items, state, fresh);
    const runtime = { ...state, context: { tokens: 20, limit: 100, percentage: 20 }, queue: [{ id: 'q', text: 'Next' }] };
    expect(projection.project(items, runtime, fresh)).toBe(first);
    const waiting = projection.project(items, { ...runtime, phase: 'waiting' }, fresh);
    expect(waiting[0]).toBe(first[0]);
    expect(waiting[1]!.streaming).toBe(false);
    const failed = projection.project(items, { ...state, phase: 'error', error: 'Disconnected' }, fresh);
    expect(failed[0]).toBe(first[0]);
    expect(failed[1]).toMatchObject({ status: 'failed', error: 'Disconnected' });
  });

  it('preserves Claude source identities and releases evicted turns and explicit replacements', () => {
    const projection = new ChatTranscriptProjection();
    const prompt = item('u', 'user', 'Inspect');
    const live = item('msg_wire:0', 'assistant', 'Reply');
    const saved = item('msg_wire:assistant:0', 'assistant', 'Reply');
    const first = projection.project([prompt, live], state, fresh);
    const reconciled = projection.project([prompt, live, saved], state, fresh);
    expect(reconciled).toEqual(chatExchanges([prompt, live, saved], state, fresh));
    expect(reconciled[0]!.answerId).toBe(first[0]!.answerId);
    projection.project([], state, fresh);
    expect(projection.project([prompt, live], state, fresh)[0]).not.toBe(first[0]);
    projection.clear();
    expect(projection.project([prompt, live, saved], state, fresh)[0]).not.toBe(reconciled[0]);
  });
});
