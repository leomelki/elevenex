import type { AgentRuntimeEvent, AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import { describe, expect, it } from 'vitest';
import { AgentConversation } from './agent-conversation';

function item(
  id: string,
  kind: AgentTranscriptItem['kind'],
  content = '',
  timestamp = new Date().toISOString(),
): AgentTranscriptItem {
  return { id, kind, content, timestamp };
}

describe('AgentConversation', () => {
  it('preserves user messages with different numeric provider ids', () => {
    const chat = new AgentConversation();
    chat.live.set([item('provider:2', 'user', 'Continue', '2')]);
    chat.applyHistoryRefresh([item('provider:1', 'user', 'Continue', '1')]);
    expect(chat.items().map((entry) => entry.id)).toEqual(['provider:1', 'provider:2']);
  });

  it('preserves separate text blocks from the same provider message', () => {
    const chat = new AgentConversation();
    chat.live.set([
      { ...item('a:0', 'assistant', 'First block', '1'), sourceMessageId: 'a' },
      { ...item('a:2', 'assistant', 'Second block', '2'), sourceMessageId: 'a' },
    ]);
    chat.applyHistoryRefresh([
      { ...item('a:assistant:0', 'assistant', 'First block', '1'), sourceMessageId: 'a' },
    ]);
    expect(chat.units().map((unit) => unit.kind === 'message' && unit.item.content)).toEqual([
      'First block',
      'Second block',
    ]);
    chat.applyHistoryRefresh([
      { ...item('a:assistant:0', 'assistant', 'First block', '1'), sourceMessageId: 'a' },
      { ...item('a:assistant:2', 'assistant', 'Second block', '2'), sourceMessageId: 'a' },
    ]);
    expect(chat.live()).toEqual([]);
    expect(chat.units()).toHaveLength(2);
  });

  it('reconciles a single text block whose index was reset by a split recording', () => {
    const chat = new AgentConversation();
    chat.live.set([{ ...item('a:1', 'assistant', 'Answer'), sourceMessageId: 'a' }]);
    chat.applyHistoryRefresh([
      { ...item('a:assistant:0', 'assistant', 'Answer'), sourceMessageId: 'a' },
    ]);
    expect(chat.live()).toEqual([]);
    expect(chat.units()).toHaveLength(1);
  });

  it('acknowledges optimistic prompts from a reconnect runtime snapshot', () => {
    const chat = new AgentConversation();
    const prompt = chat.addOptimisticPrompt('Continue');
    chat.applyRuntimeState({ liveItems: [item('saved', 'user', 'Continue', prompt.timestamp)] });
    expect(chat.optimistic()).toEqual([]);
  });
  it('acknowledges only one of two identical optimistic prompts', () => {
    const chat = new AgentConversation();
    const first = chat.addOptimisticPrompt('Continue');
    const second = chat.addOptimisticPrompt('Continue');
    expect(first.id).not.toBe(second.id);
    chat.applyHistoryRefresh([item('saved-1', 'user', 'Continue', first.timestamp)]);
    expect(chat.optimistic().map((entry) => entry.id)).toEqual([second.id]);
    chat.applyHistoryRefresh([item('saved-1', 'user', 'Continue', first.timestamp)]);
    expect(chat.optimistic().map((entry) => entry.id)).toEqual([second.id]);
  });

  it('does not match a new prompt against older history with identical text', () => {
    const chat = new AgentConversation();
    const prompt = chat.addOptimisticPrompt('Continue');
    chat.applyHistoryRefresh([item('old', 'user', 'Continue', '2020-01-01T00:00:00.000Z')]);
    expect(chat.optimistic()).toEqual([prompt]);
  });

  it('does not acknowledge a second prompt when a previously streamed user message is persisted', () => {
    const chat = new AgentConversation();
    const first = chat.addOptimisticPrompt('Continue');
    chat.apply({
      type: 'message_start',
      payload: {
        sessionId: 1,
        item: { ...item('live', 'user', 'Continue', first.timestamp), sourceMessageId: 'user-1' },
      },
    });
    expect(chat.optimistic()).toEqual([]);
    const second = chat.addOptimisticPrompt('Continue');
    chat.applyHistoryRefresh([
      { ...item('saved', 'user', 'Continue', first.timestamp), sourceMessageId: 'user-1' },
    ]);
    expect(chat.optimistic()).toEqual([second]);
  });

  it('preserves identical assistant replies in different turns', () => {
    const chat = new AgentConversation();
    chat.applyHistoryRefresh([
      item('u1', 'user', 'First', '1'),
      item('a1', 'assistant', 'Done.', '2'),
      item('u2', 'user', 'Second', '3'),
      item('a2', 'assistant', 'Done.', '4'),
    ]);
    expect(chat.units().map((unit) => unit.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('keeps text that arrived while a history refresh was in flight', () => {
    const chat = new AgentConversation();
    chat.live.set([
      { ...item('a1:0', 'assistant', 'First', '2'), sourceMessageId: 'a1' },
      { ...item('a2:0', 'assistant', 'Second', '3'), sourceMessageId: 'a2' },
    ]);
    chat.applyHistoryRefresh([
      { ...item('a1:assistant:0', 'assistant', 'First', '2'), sourceMessageId: 'a1' },
    ]);
    chat.apply({
      type: 'message_delta',
      payload: { sessionId: 1, itemId: 'a2:0', delta: ' continues' },
    });
    expect(chat.items().map((entry) => entry.content)).toEqual(['First', 'Second continues']);
  });

  it('ignores a permission resolution for a different active request', () => {
    const chat = new AgentConversation();
    chat.pendingPermissionRequest.set({ requestId: 'new' } as never);
    chat.apply({ type: 'permission_resolved', payload: { requestId: 'old' } } as AgentRuntimeEvent);
    expect(chat.pendingPermissionRequest()?.requestId).toBe('new');
  });

  it('keeps a longer live version when history still contains a partial copy', () => {
    const chat = new AgentConversation();
    chat.live.set([{ ...item('a:0', 'assistant', 'Answer continues'), sourceMessageId: 'a' }]);
    chat.applyHistoryRefresh([
      { ...item('a:assistant:0', 'assistant', 'Answer'), sourceMessageId: 'a' },
    ]);
    expect(chat.live()).toHaveLength(1);
    expect(chat.items().map((entry) => entry.content)).toEqual(['Answer continues']);
  });

  it('reuses settled change details while an unrelated turn streams', () => {
    const chat = new AgentConversation();
    chat.history.set([
      item('u1', 'user', 'Change this', '1'),
      {
        ...item('edit', 'tool_use', '', '2'),
        toolName: 'Edit',
        toolKind: 'edit',
        toolUseId: 'edit',
        toolInput: { file_path: 'a.ts', old_string: 'old', new_string: 'new' },
      },
      item('a1', 'assistant', 'Done', '3'),
      item('u2', 'user', 'Next', '4'),
    ]);
    const before = chat.renderItems().find((entry) => entry.kind === 'collapsed-turn');
    chat.live.set([item('a2', 'assistant', 'Streaming', '5')]);
    const after = chat.renderItems().find((entry) => entry.kind === 'collapsed-turn');
    expect(before?.kind === 'collapsed-turn' && before.changeDetails).toBe(
      after?.kind === 'collapsed-turn' && after.changeDetails,
    );
  });
});
