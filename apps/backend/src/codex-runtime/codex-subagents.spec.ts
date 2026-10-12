import { CodexSubagentTracker, executionStatus } from './codex-subagents.js';
import type { ClaudeTranscriptItem } from '../claude-runtime/claude-runtime.types.js';

const timestamp = '2026-10-12T10:00:00.000Z';
describe('CodexSubagentTracker', () => {
  it('bounds streaming memory across many children without truncating a retained message', () => {
    const tracker = new CodexSubagentTracker();
    const content = 'x'.repeat(512_000);
    for (let index = 0; index < 24; index++)
      tracker.storeItem(`child-${index}`, {
        id: 'reply',
        kind: 'assistant',
        content,
        timestamp,
      });
    expect(tracker.liveItems.get('child-0')?.size).toBe(0);
    expect(tracker.liveItems.get('child-23')?.get('reply')?.content).toBe(
      content,
    );
    expect(
      [...tracker.liveItems.values()].reduce(
        (count, entries) => count + entries.size,
        0,
      ),
    ).toBeLessThan(20);
  });
  it('attaches the assignment when thread/started precedes spawn completion and preserves its nickname', () => {
    const tracker = new CodexSubagentTracker();
    tracker.upsert(
      'child',
      { displayName: 'Ada', agentType: 'explorer', executionStatus: 'running' },
      timestamp,
    );
    tracker.collaboration(
      {
        id: 'spawn',
        tool: 'spawnAgent',
        receiverThreadIds: ['child'],
        prompt: 'Inspect the caching layer',
        model: 'gpt-5.4-mini',
        agentsStates: { child: { status: 'running' } },
      },
      timestamp,
      'root',
    );
    expect(tracker.agents.get('child')).toMatchObject({
      displayName: 'Ada',
      agentType: 'explorer',
      prompt: 'Inspect the caching layer',
      parentToolUseId: 'spawn',
      model: 'gpt-5.4-mini',
      executionStatus: 'running',
    });
  });

  it('tracks nested delegation and does not turn an unrelated wait target into a session child', () => {
    const tracker = new CodexSubagentTracker();
    tracker.collaboration(
      {
        tool: 'spawnAgent',
        senderThreadId: 'root',
        receiverThreadIds: ['child'],
      },
      timestamp,
      'root',
    );
    tracker.collaboration(
      {
        tool: 'spawnAgent',
        senderThreadId: 'child',
        receiverThreadIds: ['grandchild'],
      },
      timestamp,
      'root',
    );
    tracker.collaboration(
      {
        tool: 'wait',
        agentsStates: {
          foreign: { status: 'running' },
          grandchild: { status: 'completed', message: 'Done' },
        },
      },
      timestamp,
      'root',
    );
    expect(tracker.agents.has('foreign')).toBe(false);
    expect(tracker.agents.get('grandchild')).toMatchObject({
      parentAgentId: 'child',
      status: 'stopped',
      executionStatus: 'completed',
      lastAssistantMessage: 'Done',
    });
  });

  it.each([
    'pendingInit',
    'running',
    'interrupted',
    'completed',
    'errored',
    'shutdown',
    'notFound',
  ])('retains distinct %s lifecycle states', (status) => {
    const tracker = new CodexSubagentTracker();
    tracker.collaboration(
      {
        tool: 'spawnAgent',
        receiverThreadIds: ['child'],
        agentsStates: { child: { status } },
      },
      timestamp,
      'root',
    );
    expect(tracker.agents.get('child')?.executionStatus).toBe(
      executionStatus(status),
    );
    expect(tracker.agents.get('child')?.status).toBe(
      ['pendingInit', 'running'].includes(status) ? 'started' : 'stopped',
    );
  });

  it('restores namespaced spawn/wait calls and clears completion when follow-up work begins', () => {
    const history: ClaudeTranscriptItem[] = [
      {
        id: 'spawn',
        kind: 'tool_use',
        toolUseId: 'spawn',
        providerToolName: 'functions.spawn_agent',
        toolInput: { message: 'Review tests', agent_type: 'explorer' },
        timestamp,
      },
      {
        id: 'spawn-output',
        kind: 'tool_result',
        toolUseId: 'spawn',
        content: '{"agent_id":"child","nickname":"Ada"}',
        timestamp,
      },
      {
        id: 'wait',
        kind: 'tool_use',
        toolUseId: 'wait',
        providerToolName: 'wait',
        timestamp,
      },
      {
        id: 'wait-output',
        kind: 'tool_result',
        toolUseId: 'wait',
        content: '{"status":{"child":{"completed":"Found a race"}}}',
        timestamp,
      },
    ];
    const tracker = new CodexSubagentTracker();
    tracker.restore(history, 'root');
    expect(tracker.agents.get('child')).toMatchObject({
      displayName: 'Ada',
      agentType: 'explorer',
      prompt: 'Review tests',
      parentToolUseId: 'spawn',
      status: 'stopped',
      lastAssistantMessage: 'Found a race',
    });
    tracker.restore(
      [
        {
          id: 'followup',
          kind: 'tool_use',
          toolUseId: 'followup',
          toolName: 'followup_task',
          toolInput: { id: 'child' },
          timestamp,
        },
        {
          id: 'followup-output',
          kind: 'tool_result',
          toolUseId: 'followup',
          content: '{}',
          timestamp,
        },
      ],
      'root',
    );
    expect(tracker.agents.get('child')).toMatchObject({
      status: 'started',
      executionStatus: 'running',
    });
    expect(tracker.agents.get('child')?.completedAt).toBeUndefined();
  });

  it('does not create a child from a failed spawn or malformed tool output', () => {
    const tracker = new CodexSubagentTracker();
    tracker.restore(
      [
        {
          id: 'spawn',
          kind: 'tool_use',
          toolUseId: 'spawn',
          toolName: 'spawn_agent',
          timestamp,
        },
        {
          id: 'result',
          kind: 'tool_result',
          toolUseId: 'spawn',
          content: '{"agent_id":"foreign"}',
          isError: true,
          timestamp,
        },
      ],
      'root',
    );
    expect(tracker.agents.size).toBe(0);
  });
});
