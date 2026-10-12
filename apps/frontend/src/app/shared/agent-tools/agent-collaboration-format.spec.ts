import { describe, expect, it, vi } from 'vitest';
import { buildSubagentIndex, collaborationView } from './agent-collaboration-format';
import { describeAgentTool, shouldHideToolCall } from './agent-tool-format';
import { pairTranscript } from '@/shared/agent-chat/transcript/paired-transcript';
import type { AgentSubagentState, AgentTranscriptItem } from '@/shared/models/agent-runtime.model';

const timestamp = '2026-10-12T10:00:00.000Z';
const ada: AgentSubagentState = {
  agentId: 'child-1',
  agentPath: '/root/reviewer',
  displayName: 'Ada',
  agentType: 'explorer',
  status: 'started',
  executionStatus: 'running',
  timestamp,
};
const agents = buildSubagentIndex([ada]);
function call(name: string, input: unknown = {}): AgentTranscriptItem {
  return {
    id: 'call',
    toolUseId: 'call',
    kind: 'tool_use',
    providerToolName: name,
    toolName: name,
    toolInput: input,
    timestamp,
  };
}
function result(content: unknown, isError = false): AgentTranscriptItem {
  return {
    id: 'result',
    toolUseId: 'call',
    kind: 'tool_result',
    content: typeof content === 'string' ? content : JSON.stringify(content),
    isError,
    timestamp,
  };
}
describe('agent collaboration presentation', () => {
  it('keeps plain tool replies and supports direct agent-array receipts', () => {
    expect(
      collaborationView(call('wait_agent'), result('There are no new updates yet.'), agents)
        ?.receiptText,
    ).toBe('There are no new updates yet.');
    const view = collaborationView(
      call('list_agents'),
      result([{ agent_id: 'child-1', agent_status: 'running' }]),
      agents,
    )!;
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].label).toBe('Ada');
  });
  it('does not reinterpret MCP tools or unsupported names as agent actions', () => {
    expect(
      collaborationView(
        call('send_message', { server: 'notifications', arguments: {} }),
        result({}),
      ),
    ).toBeNull();
    expect(collaborationView(call('constructor'), result({}))).toBeNull();
  });
  it('reuses parsed rosters when only live agent metadata changes, without sharing mutable view rows', () => {
    const receipt = result({
      agents: [{ agent_id: 'child-1', agent_status: 'running' }],
      cache_marker: 'unique-roster',
    });
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const first = collaborationView(call('list_agents'), receipt, agents)!;
      first.rows[0].label = 'Changed view';
      const next = collaborationView(call('list_agents'), receipt, agents)!;
      expect(parse).toHaveBeenCalledTimes(1);
      expect(next.rows[0].label).toBe('Ada');
    } finally {
      parse.mockRestore();
    }
  });
  it('shows a successful spawn separately from the running agent and resolves task paths to inspectable thread IDs', () => {
    const view = collaborationView(
      call('collaboration.spawn_agent', {
        message: 'Review **caching**',
        fork_turns: 'all',
        model: 'gpt-5.4-mini',
      }),
      result({ task_name: '/root/reviewer' }),
      agents,
    )!;
    expect(view).toMatchObject({
      label: 'Delegate task',
      outcome: 'Agent spawned',
      payload: 'Review **caching**',
      metadata: ['gpt-5.4-mini', 'Full conversation context'],
    });
    expect(view.rows[0]).toMatchObject({
      label: 'Ada',
      agentId: 'child-1',
      status: { executionStatus: 'running' },
    });
  });
  it('renders Codex messaging instead of hiding it as Claude team housekeeping', () => {
    const message = call('send_message', {
      target: '/root/reviewer',
      message: 'Focus on reconnects',
    });
    expect(describeAgentTool(message)).toMatchObject({
      kind: 'agent_collaboration',
      verb: 'Message agent',
    });
    expect(shouldHideToolCall(message.toolName, message.toolInput)).toBe(false);
    expect(pairTranscript([message, result({ queued: true })])).toHaveLength(1);
    expect(shouldHideToolCall('SendMessage', { message: { type: 'message' } })).toBe(true);
    expect(collaborationView(message, result({ queued: true }), agents)?.outcome).toBe(
      'Message sent',
    );
  });
  it('keeps timeout outcomes and historical statuses distinct from newer live work', () => {
    const index = buildSubagentIndex([{ ...ada, timestamp: '2026-10-12T10:01:00.000Z' }]);
    const view = collaborationView(
      call('wait_agent', { target: 'child-1', timeout_ms: 60000 }),
      result({ status: { 'child-1': { completed: 'Found a race' } }, timed_out: true }),
      index,
    )!;
    expect(view).toMatchObject({
      outcome: 'Wait timed out',
      tone: 'warning',
      metadata: ['Timeout 1m'],
    });
    expect(view.rows[0]).toMatchObject({
      status: { executionStatus: 'completed' },
      currentStatus: { executionStatus: 'running' },
      response: 'Found a race',
    });
  });
  it('shows structured agent lists, root identity, failures and completed states', () => {
    const view = collaborationView(
      call('list_agents'),
      result({
        agents: [
          { agent_name: '/root', agent_status: 'running' },
          { agent_name: '/root/reviewer', agent_status: 'completed' },
          { agent_id: 'foreign', nickname: 'Grace', agent_status: 'errored' },
        ],
      }),
      agents,
    )!;
    expect(view.outcome).toBe('3 agents · 1 active · 1 need attention');
    expect(view.rows[0].label).toBe('Main agent');
    expect(view.rows[1]).toMatchObject({
      label: 'Ada',
      agentId: 'child-1',
      status: { executionStatus: 'completed' },
    });
    expect(view.rows[2]).toMatchObject({ label: 'Grace', status: { executionStatus: 'error' } });
    expect(view.rows[2].agentId).toBeUndefined();
  });
  it('does not guess which agent owns an ambiguous short task name', () => {
    const index = buildSubagentIndex([
      ada,
      { ...ada, agentId: 'child-2', agentPath: '/root/other/reviewer' },
    ]);
    expect(index.get('reviewer')).toBeUndefined();
    const view = collaborationView(
      call('send_input', { id: 'reviewer', message: 'Check tests' }),
      null,
      index,
      true,
    )!;
    expect(view.outcome).toBe('Sending');
    expect(view.rows[0].agentId).toBeUndefined();
  });
  it('unwraps text-block receipts and avoids treating a script wait as an agent tool', () => {
    const view = collaborationView(
      call('resumeAgent', { id: 'child-1' }),
      result(
        JSON.stringify([
          { type: 'text', text: '{"agentsStates":{"child-1":{"status":"running"}}}' },
        ]),
      ),
      agents,
    )!;
    expect(view.outcome).toBe('Agent resumed');
    expect(
      collaborationView(call('functions.wait', { cell_id: 'script-1' }), result({}), agents),
    ).toBeNull();
  });
  it('hides sealed assignments and preserves explicit errors and absent receipts', () => {
    const sealed = `gAAAAA${'x'.repeat(400)}`;
    const view = collaborationView(
      call('followup_task', { target: 'child-1', message: sealed }),
      null,
      agents,
    )!;
    expect(view).toMatchObject({ payloadUnavailable: true, outcome: 'No result recorded' });
    expect(view.payload).toBeUndefined();
    const failed = collaborationView(
      call('close_agent', { id: 'child-1' }),
      result({ error: { message: 'Agent not found' } }, true),
      agents,
    )!;
    expect(failed).toMatchObject({
      tone: 'destructive',
      outcome: 'Failed',
      error: 'Agent not found',
    });
  });
});
