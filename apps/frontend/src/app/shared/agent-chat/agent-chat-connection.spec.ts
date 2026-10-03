import type { AgentRuntimeEvent, AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { AgentRuntimeWebsocketService } from '@/shared/services/agent-runtime-websocket.service';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AgentChatConnection } from './agent-chat-connection';
import { AgentConversation } from './agent-conversation';

function setup() {
  const events = new Subject<AgentRuntimeEvent>();
  const history = new Subject<AgentTranscriptItem[]>();
  const ws = { borrow: vi.fn(() => events.asObservable()), releaseBorrow: vi.fn(), send: vi.fn() };
  const api = { getHistory: vi.fn(() => history.asObservable()) };
  const connection = new AgentChatConnection(
    ws as unknown as AgentRuntimeWebsocketService,
    api as unknown as AgentRuntimeApiService,
  );
  return { connection, ws, api, events, history };
}

describe('AgentChatConnection', () => {
  it('coalesces overlapping history refreshes', async () => {
    const { connection, api, history } = setup();
    connection.attach({ sessionId: 1, provider: 'claude' }, new AgentConversation());
    const first = connection.refreshHistory();
    const second = connection.refreshHistory();
    expect(second).toBe(first);
    expect(api.getHistory).toHaveBeenCalledTimes(1);
    history.next([]);
    await first;
    connection.detach();
  });

  it('drops an old response after switching provider on the same session', async () => {
    const { connection, history } = setup();
    const chat = new AgentConversation();
    connection.attach({ sessionId: 1, provider: 'claude' }, chat);
    const refresh = connection.refreshHistory();
    connection.attach({ sessionId: 1, provider: 'codex' }, chat);
    history.next([{ id: 'old', kind: 'assistant', content: 'Old response', timestamp: '1' }]);
    await refresh;
    expect(chat.history()).toEqual([]);
    connection.detach();
  });

  it('drops a response from a previous attachment to the same target', async () => {
    const { connection, history } = setup();
    const chat = new AgentConversation();
    const target = { sessionId: 1, provider: 'claude' };
    connection.attach(target, chat);
    const refresh = connection.refreshHistory();
    connection.detach();
    connection.attach(target, chat);
    history.next([{ id: 'old', kind: 'assistant', timestamp: '1' }]);
    await refresh;
    expect(chat.history()).toEqual([]);
    connection.detach();
  });

  it('unsubscribes and releases its borrow on detach', () => {
    const { connection, events, ws } = setup();
    const chat = new AgentConversation();
    connection.attach({ sessionId: 1, provider: 'claude' }, chat);
    connection.detach();
    events.next({ type: 'error', payload: { sessionId: 1, message: 'Late event' } });
    expect(chat.lastError()).toBeNull();
    expect(ws.releaseBorrow).toHaveBeenCalledExactlyOnceWith(1, 'claude');
  });

  it('reports refresh failures without losing the transcript', async () => {
    const { connection, history } = setup();
    const chat = new AgentConversation();
    chat.history.set([{ id: 'saved', kind: 'assistant', content: 'Saved', timestamp: '1' }]);
    connection.attach({ sessionId: 1, provider: 'claude' }, chat);
    const refresh = connection.refreshHistory();
    history.error(new Error('Offline'));
    await refresh;
    expect(chat.history()[0].content).toBe('Saved');
    expect(chat.lastError()).toContain('refresh');
    connection.detach();
  });
});
