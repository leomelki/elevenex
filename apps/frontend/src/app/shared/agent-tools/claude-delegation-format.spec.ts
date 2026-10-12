import { describe, expect, it } from 'vitest';
import { claudeDelegationTool, claudeDelegationView } from './claude-delegation-format';
import type { AgentSubagentState, AgentTranscriptItem } from '@/shared/models/agent-runtime.model';

const call = (name: string, input: unknown): AgentTranscriptItem => ({
  id: 'call',
  kind: 'tool_use',
  toolUseId: 'dispatch',
  toolName: name,
  toolInput: input,
  timestamp: 'now',
});
describe('Claude collaboration cards', () => {
  it('shows live delegation independently of the completed launch tool', () => {
    const worker: AgentSubagentState = {
      agentId: 'child',
      displayName: 'Reviewer',
      agentType: 'reviewer',
      parentToolUseId: 'dispatch',
      status: 'started',
      executionStatus: 'running',
      timestamp: 'now',
    };
    const view = claudeDelegationView(
      call('Agent', { prompt: 'Check tests', description: 'Review changes' }),
      {
        id: 'result',
        kind: 'tool_result',
        timestamp: 'now',
        providerToolResult: {
          agentId: 'child',
          isAsync: true,
          content: [{ type: 'text', text: 'Agent launched' }],
        },
      },
      new Map([['child', worker]]),
    );
    expect(view.agent).toBe(worker);
    expect(view.prompt).toBe('Check tests');
    expect(view.report).toBe('');
    expect(view.background).toBe(true);
  });
  it('renders current and legacy message shapes and resumes by stable ID', () => {
    expect(
      claudeDelegationView(call('SendMessage', { to: 'child', message: 'Continue review' }), null),
    ).toMatchObject({ reference: 'child', message: 'Continue review' });
    expect(
      claudeDelegationView(
        call('SendMessage', {
          recipient: 'child',
          message: { type: 'message', content: 'Use the new schema' },
        }),
        null,
      ),
    ).toMatchObject({ reference: 'child', message: 'Use the new schema' });
  });
  it('uses raw reports when structured data is missing without displaying the metadata trailer', () => {
    const result: AgentTranscriptItem = {
      id: 'done',
      kind: 'tool_result',
      timestamp: 'now',
      content: 'All checked.\nagentId: child\n<usage>total_tokens: 300</usage>',
    };
    expect(claudeDelegationView(call('Task', {}), result)).toMatchObject({
      report: 'All checked.',
      reference: 'child',
    });
  });
  it('does not intercept similarly named MCP tools or recurse on missing values', () => {
    expect(claudeDelegationTool(call('mcp__service__Agent', {}))).toBeNull();
    expect(claudeDelegationTool(call('Agent', { server: 'workflow' }))).toBeNull();
    expect(claudeDelegationView(call('TaskStop', { task_id: 'shell' }), null)).toMatchObject({
      title: 'Stop task',
      report: '',
      reference: 'shell',
    });
  });
});
