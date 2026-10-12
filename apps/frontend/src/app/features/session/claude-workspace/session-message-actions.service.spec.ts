import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of, Subject } from 'rxjs';
import type {
  AgentSubagentHistoryPayload,
  AgentSubagentState,
} from '@/shared/models/agent-runtime.model';
import { ClaudeRuntimeApiService } from '@/shared/services/claude-runtime-api.service';
import { SessionsService } from '@/shared/services/sessions.service';
import { ReviewChatsService } from '@/shared/services/review-chats.service';
import { SessionMessageActions } from './session-message-actions.service';
import { SessionRuntime } from './session-runtime.service';
import { SessionDraftContext } from './session-draft-context.service';

describe('SessionMessageActions child history', () => {
  const started: AgentSubagentState = {
    agentId: 'worker',
    agentType: 'worker',
    runId: '001',
    status: 'started',
    timestamp: '2026-10-12T10:00:00Z',
  };
  const stopped: AgentSubagentState = {
    ...started,
    status: 'stopped',
    timestamp: '2026-10-12T10:01:00Z',
  };
  const agents = signal<AgentSubagentState[]>([]);
  const history = (
    ids: number[],
    agent = agents()[0],
    hasEarlier = false,
  ): AgentSubagentHistoryPayload => ({
    subagent: { ...agent },
    transcriptAvailable: true,
    hasEarlier,
    history: ids.map((id) => ({
      id: `message-${id}`,
      transcriptMessageId: `message-${id}`,
      kind: 'assistant',
      content: `Response ${id}`,
      timestamp: new Date(Date.UTC(2026, 9, 12, 10, 0, id)).toISOString(),
    })),
  });
  let actions: SessionMessageActions;
  let api: { getSubagentHistory: ReturnType<typeof vi.fn> };
  let runtime: {
    events: Subject<never>;
    subagents: typeof agents;
    isTranscriptReadOnly: () => boolean;
    bootstrapVersion: number;
    sessionId: number;
    watchSubagent: ReturnType<typeof vi.fn>;
    clearSubagentLiveItems: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    agents.set([started]);
    api = { getSubagentHistory: vi.fn(() => of(history([1]))) };
    runtime = {
      events: new Subject<never>(),
      subagents: agents,
      isTranscriptReadOnly: () => false,
      bootstrapVersion: 1,
      sessionId: 7,
      watchSubagent: vi.fn(() => vi.fn()),
      clearSubagentLiveItems: vi.fn(),
    };
    TestBed.configureTestingModule({
      providers: [
        SessionMessageActions,
        { provide: SessionRuntime, useValue: runtime },
        { provide: SessionDraftContext, useValue: {} },
        { provide: ClaudeRuntimeApiService, useValue: api },
        { provide: SessionsService, useValue: {} },
        { provide: ReviewChatsService, useValue: {} },
      ],
    });
    actions = TestBed.inject(SessionMessageActions);
  });
  it('refreshes a worker that finished while closed and retains previously loaded messages', async () => {
    actions.openSessionAgents('worker');
    await Promise.resolve();
    actions.closeAgentInspector();
    agents.set([stopped]);
    api.getSubagentHistory.mockReturnValue(of(history([2, 3])));
    actions.openSessionAgents('worker');
    await Promise.resolve();
    expect(api.getSubagentHistory).toHaveBeenCalledTimes(2);
    expect(actions.agentHistoryById()['worker'].data?.history.map((item) => item.id)).toEqual([
      'message-1',
      'message-2',
      'message-3',
    ]);
  });
  it('reuses unchanged settled history and does not churn the selected subscription', async () => {
    agents.set([stopped]);
    actions.openSessionAgents('worker');
    await Promise.resolve();
    actions.selectAgentInspectorAgent('worker');
    expect(runtime.watchSubagent).toHaveBeenCalledTimes(1);
    actions.closeAgentInspector();
    actions.openSessionAgents('worker');
    await Promise.resolve();
    expect(api.getSubagentHistory).toHaveBeenCalledTimes(1);
    expect(runtime.watchSubagent).toHaveBeenCalledTimes(2);
  });
  it('refreshes a resumed run even when its timestamp and settled status match', async () => {
    agents.set([stopped]);
    actions.openSessionAgents('worker');
    await Promise.resolve();
    actions.closeAgentInspector();
    agents.set([{ ...stopped, runId: '002' }]);
    actions.openSessionAgents('worker');
    await Promise.resolve();
    expect(api.getSubagentHistory).toHaveBeenCalledTimes(2);
    expect(actions.agentHistoryById()['worker'].data?.subagent.runId).toBe('002');
  });
  it('fetches a fresh live tail when reopening even without a lifecycle revision', async () => {
    actions.openSessionAgents('worker');
    await Promise.resolve();
    actions.closeAgentInspector();
    actions.openSessionAgents('worker');
    await Promise.resolve();
    expect(api.getSubagentHistory).toHaveBeenCalledTimes(2);
  });
  it('fetches a final tail when completion races an outstanding request', async () => {
    const pending = new Subject<AgentSubagentHistoryPayload>();
    api.getSubagentHistory.mockReturnValueOnce(pending.asObservable());
    actions.openSessionAgents('worker');
    agents.set([stopped]);
    api.getSubagentHistory.mockReturnValue(of(history([1, 2])));
    pending.next(history([1], started));
    await Promise.resolve();
    await Promise.resolve();
    expect(api.getSubagentHistory).toHaveBeenCalledTimes(2);
    expect(actions.agentHistoryById()['worker'].data?.history).toHaveLength(2);
  });
  it('coalesces tail refreshes during pagination without restoring the exhausted earlier flag', async () => {
    agents.set([stopped]);
    api.getSubagentHistory.mockReturnValueOnce(of(history([2, 3], stopped, true)));
    actions.openSessionAgents('worker');
    await Promise.resolve();
    const pending = new Subject<AgentSubagentHistoryPayload>();
    api.getSubagentHistory.mockReturnValueOnce(pending.asObservable());
    actions.loadEarlierAgentHistory('worker');
    actions.refreshAgentHistory('worker');
    actions.refreshAgentHistory('worker');
    expect(api.getSubagentHistory).toHaveBeenCalledTimes(2);
    api.getSubagentHistory.mockReturnValue(of(history([3, 4], stopped, true)));
    pending.next(history([0, 1], stopped, false));
    await Promise.resolve();
    await Promise.resolve();
    expect(api.getSubagentHistory).toHaveBeenCalledTimes(3);
    expect(api.getSubagentHistory).toHaveBeenNthCalledWith(2, 7, 'worker', 'message-2');
    expect(actions.agentHistoryById()['worker'].data?.history.map((item) => item.id)).toEqual([
      'message-0',
      'message-1',
      'message-2',
      'message-3',
      'message-4',
    ]);
    expect(actions.agentHistoryById()['worker'].data?.hasEarlier).toBe(false);
  });
  it('cancels a queued refresh when closing the inspector', async () => {
    const pending = new Subject<AgentSubagentHistoryPayload>();
    api.getSubagentHistory.mockReturnValue(pending.asObservable());
    actions.openSessionAgents('worker');
    actions.refreshAgentHistory('worker');
    actions.closeAgentInspector();
    pending.next(history([1]));
    await Promise.resolve();
    expect(api.getSubagentHistory).toHaveBeenCalledTimes(1);
  });
  it('keeps the selected history when an older selection finishes above cache capacity', async () => {
    const workers = Array.from({ length: 13 }, (_, i) => ({ ...stopped, agentId: `worker-${i}` }));
    agents.set(workers);
    const pending = new Subject<AgentSubagentHistoryPayload>();
    api.getSubagentHistory.mockImplementation((_sessionId: number, id: string) =>
      id === 'worker-12'
        ? pending.asObservable()
        : of(
            history(
              [1],
              workers.find((agent) => agent.agentId === id),
            ),
          ),
    );
    for (let i = 0; i < 12; i++) {
      actions.openSessionAgents(`worker-${i}`);
      await Promise.resolve();
    }
    actions.openSessionAgents('worker-12');
    actions.selectAgentInspectorAgent('worker-0');
    pending.next(history([1], workers[12]));
    await Promise.resolve();
    expect(Object.keys(actions.agentHistoryById())).toHaveLength(12);
    expect(actions.agentHistoryById()['worker-0'].data).toBeTruthy();
  });
  it('ignores responses and queued refreshes after switching conversations', async () => {
    const pending = new Subject<AgentSubagentHistoryPayload>();
    api.getSubagentHistory.mockReturnValue(pending.asObservable());
    actions.openSessionAgents('worker');
    actions.refreshAgentHistory('worker');
    runtime.bootstrapVersion++;
    actions.reset();
    pending.next(history([1]));
    await Promise.resolve();
    expect(actions.agentHistoryById()).toEqual({});
    expect(api.getSubagentHistory).toHaveBeenCalledTimes(1);
  });
});
