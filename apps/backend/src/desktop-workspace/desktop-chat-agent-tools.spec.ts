import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';
import { sessionAgentPrompt, splitSessionAgentPrompt } from '../sessions/session-agent-message.js';
import { chatAgentEntry } from './desktop-chat-agent-tools.js';
import { chatItem, chatState } from './desktop-chat-projection.js';
import { ChatCompletedTurns } from './desktop-chat-turns.js';

const at = '2026-11-24T02:00:00.000Z';
const row = (id: string, kind: AgentTranscriptItem['kind'], extra: Partial<AgentTranscriptItem> = {}): AgentTranscriptItem =>
  ({ id, kind, timestamp: at, ...extra });

describe('projecting delegation into chat', () => {
  it.each([
    ['Claude Code', 'mcp__elevenex__create_session', { name: 'Review' }, [{ type: 'text', text: '{"data":{"sessionId":8,"provider":"claude"}}' }]],
    ['Codex', 'create_session', { server: 'elevenex', arguments: { name: 'Review' } }, { structured_content: { data: { sessionId: 8, provider: 'codex' } } }],
    ['Pi', 'mcp__elevenex__create_session', { name: 'Review' }, { details: { data: { sessionId: 8, provider: 'pi' } } }],
    ['OpenCode', 'elevenex_create_session', { name: 'Review' }, '{"data":{"sessionId":8,"provider":"opencode"}}'],
  ])('projects the %s invocation and receipt', (_label, providerToolName, toolInput, providerToolResult) => {
    const call = row('call', 'tool_use', { providerToolName, toolInput, toolKind: 'mcp' });
    const receipt = row('receipt', 'tool_result', { providerToolResult });
    expect(chatAgentEntry(call, receipt)).toMatchObject({
      operation: { type: 'launch', title: 'Review' },
      result: { session: { sessionId: 8, selection: { provider: expect.any(String) } } },
    });
  });
  it('projects authenticated sender metadata from saved, dispatching and legacy prompts', () => {
    const parent = { sessionId: 7, taskId: 4, title: 'Review <retry>', selection: { provider: 'claude' } };
    const prompt = sessionAgentPrompt('Review the queue.', parent, 'assignment');
    expect(chatItem(row('prompt', 'user', { content: prompt }))).toMatchObject({
      text: 'Review the queue.', sender: { session: parent, purpose: 'assignment' },
    });
    expect(chatState({ pendingPrompts: [{ id: 'p', prompt }] }, 'codex', []).queue).toMatchObject([
      { id: 'p', text: 'Review the queue.', sender: { session: parent } },
    ]);
    expect(splitSessionAgentPrompt('[Elevenex session message from session #7]\n\nFollow up')).toEqual({
      text: 'Follow up', sender: { session: { sessionId: 7 }, purpose: 'message' },
    });
  });

  it('keeps replies at the receipt position and preserves the launch in a compact saved turn', () => {
    const start = row('start', 'tool_use', { toolKind: 'mcp', toolUseId: 'c1',
      toolInput: { server: 'elevenex', tool: 'create_session', arguments: { name: 'Review', provider: 'codex', requestId: 'review' } } });
    const created = row('created', 'tool_result', { toolUseId: 'c1',
      providerToolResult: { structuredContent: { data: { sessionId: 8, name: 'Review', taskId: 4, provider: 'codex', promptStatus: 'running' } } } });
    const wait = row('wait', 'tool_use', { toolKind: 'mcp', toolUseId: 'c2',
      providerToolName: 'mcp__elevenex__await_session_event', toolInput: { sessionIds: [8, 8, -1] } });
    const answer = row('received', 'tool_result', { toolUseId: 'c2',
      content: JSON.stringify([{ type: 'text', text: JSON.stringify({ data: {
        sessionId: 8, taskId: 4, status: 'completed', reply: { id: 'child-final', text: '**Ready.**', truncated: false },
      } }) }]),
    });
    const prompt = row('prompt', 'user', { content: 'Review it' });
    const final = row('reply', 'assistant', { content: 'All set.', assistantPhase: 'final' });
    const turn = [prompt, start, created, wait, answer, final];
    const projector = new ChatCompletedTurns();
    const summary = projector.summarize(turn, 0, turn.length, new Set(), undefined, true);
    expect(summary?.completedTurn?.agents).toMatchObject([
      { id: 'start', operation: { type: 'launch', requestId: 'review' }, result: { session: { sessionId: 8, title: 'Review' }, status: 'running' } },
      { id: 'wait', operation: { type: 'wait', sessions: [8] }, result: { status: 'completed', detail: '**Ready.**' } },
    ]);
    expect(summary?.completedTurn?.agents?.[1]?.result?.reply).toBeUndefined();
    const work = projector.timeline(turn, summary!.completedTurn!.revision, 0, true);
    expect(work?.timeline[3]).toMatchObject({
      id: 'received', kind: 'result', agent: { id: 'wait', result: { reply: { id: 'child-final', text: '**Ready.**' } } },
    });
    expect(chatAgentEntry({ ...start, toolInput: { server: 'other', tool: 'create_session' } }, created)).toBeUndefined();
  });

  it('uses a native harness wait receipt to record a finished agent outcome', () => {
    const wait = row('wait', 'tool_use', { toolKind: 'agent_collaboration', toolName: 'multi_agent.wait_agent',
      toolInput: { receiverThreadIds: ['worker'] } });
    const answer = row('receipt', 'tool_result', {
      content: '{"agentsStates":{"worker":{"status":"completed","message":"Checked the tracker."}}}',
    });
    expect(chatAgentEntry(wait, answer)).toMatchObject({
      operation: { type: 'native-wait', agents: ['worker'] },
      result: { agents: [{ agentId: 'worker', status: 'completed', detail: 'Checked the tracker.' }] },
    });
  });

  it('projects a blocking delegation result on its launch receipt', () => {
    const call = row('launch', 'tool_use', {
      toolKind: 'mcp', providerToolName: 'mcp__elevenex__create_session',
      toolInput: { name: 'Review', mode: 'wait', provider: 'codex' },
    });
    const answer = row('result', 'tool_result', {
      providerToolResult: { data: {
        sessionId: 8, provider: 'codex', accepted: true, promptStatus: 'running',
        result: { event: 'completed', status: 'completed', reply: { id: 'final', text: 'Reviewed.' } },
      } },
    });
    expect(chatAgentEntry(call, answer)?.result).toMatchObject({
      status: 'completed', detail: 'Reviewed.',
    });
    expect(chatAgentEntry(call, answer)?.result?.reply).toBeUndefined();
    expect(chatAgentEntry(answer, call)).toMatchObject({
      operation: { type: 'launch', title: 'Review' },
      result: { session: { sessionId: 8 }, status: 'completed', event: 'completed', reply: { id: 'final', text: 'Reviewed.' } },
    });
  });
});
