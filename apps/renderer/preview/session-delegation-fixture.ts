import type {
  DelegatedSessionWork, SessionAgentOperation, SessionAgentReference, SessionAgentTurnEntry,
  SessionChatItem, SessionChatState, WorkspaceSession,
} from '@elevenex/shared';
import { previewChatState, type SessionChatFixture } from './session-chat-fixture';

export type DelegationScene = 'starting' | 'running' | 'waiting' | 'reply' | 'settled' | 'failed' | 'harnesses';

const parent = { sessionId: 101, taskId: 11, title: 'Coordinate the retry fix', selection: { provider: 'claude', model: 'Opus', effort: 'high' } };
const review = { sessionId: 202, taskId: 11, title: 'Review the retry boundary', selection: { provider: 'codex', model: 'GPT-6', effort: 'high' } };
const tests = { sessionId: 203, taskId: 11, title: 'Write regression tests', selection: { provider: 'codex', model: 'GPT-6', effort: 'medium' } };
const docs = { sessionId: 204, taskId: 11, title: 'Check provider documentation', selection: { provider: 'pi', model: 'Sonnet', effort: 'low' } };
const openCode = { sessionId: 205, taskId: 11, title: 'Check the fallback path', selection: { provider: 'opencode', model: 'openrouter/anthropic/claude-sonnet', effort: 'high' } };
const reply = 'Both requests can reach the provider before the original check records the claim.\n\n' +
  '### What I checked\n\n- The retry key stays stable while a pending request is owned.\n' +
  '- Delayed successes preserve the existing claim.\n- Conflicting requests now share the same result.\n\n' +
  'The new regression covers two requests entering the boundary at the same time.';

export function seedDelegation(chat: SessionChatFixture, scene: DelegationScene): readonly WorkspaceSession[] {
  const now = Date.now(), at = (age = 0) => new Date(now - age).toISOString();
  const done = scene === 'settled', incoming = done || scene === 'reply';
  const waiting = scene === 'waiting';
  const started = scene !== 'starting';
  const failed = scene === 'failed';
  const record = (id: string, kind: SessionChatItem['kind'], text: string, extra: Partial<SessionChatItem> = {}): SessionChatItem => ({
    id, kind, text, toolId: null, toolName: null, toolKind: null, input: '', timestamp: at(240_000),
    truncated: false, error: false, ...extra,
  });
  const tool = (id: string, operation: SessionAgentOperation, result?: SessionAgentTurnEntry['result']): SessionChatItem => {
    const agent = { id, toolId: id, at: at(started ? 205_000 : 1500), operation,
      ...(result ? { result, endedAt: at(operation.type === 'wait' ? 1000 : 200_000) } : {}) };
    return record(id, 'tool_use', '', { agent, toolId: id, toolName: 'MCP', toolKind: 'mcp' });
  };
  const launch = (session: SessionAgentReference, accepted: boolean) =>
    tool('launch-' + session.sessionId, { type: 'launch', title: session.title, identity: session.selection, requestId: 'start-' + session.sessionId },
      accepted ? { session, status: 'running', delivery: 'accepted' } : undefined);
  const childWork = (session: SessionAgentReference, status: DelegatedSessionWork['status'], detail: string): DelegatedSessionWork =>
    ({ session, status, detail, startedAt: at(200_000),
      endedAt: status === 'completed' || status === 'error' ? at(6000) : null, toolUses: 17, tokens: 18520 });
  const wait = tool('wait-reply', { type: 'wait', sessions: [202, 203] },
    incoming ? { session: review, status: 'completed', detail: 'Both requests could reach the provider before the original claim.', event: 'completed' } : undefined);
  const call = wait.agent!;
  const returned = { ...call, result: { ...call.result, session: review, status: 'completed' as const,
    reply: { id: 'review-reply', text: reply, truncated: false, changes: { total: 1, files: [{ path: 'src/payments/retry-claims.spec.ts', status: 'M' as const, add: 18, del: 2 }] } } } };
  const messageId = '00000000-0000-4000-8000-000000000001';
  const items = [
    record('delegation-prompt', 'user', 'Find the race in payment retries and add coverage for concurrent requests.'),
    record('delegate-commentary', 'assistant', 'I’ll trace the claim flow and ask another agent to check the edge cases.', { assistantPhase: 'commentary' }),
    launch(review, started),
    ...(started ? [
      launch(tests, true),
      tool('spawn-native', { type: 'native', title: 'Audit the callback paths', message: 'Explore' },
        { agentId: 'native-inspect', status: 'completed', detail: 'The callback preserves the original retry key.' }),
      ...(scene === 'harnesses' ? [launch(docs, true), launch(openCode, true)] : []),
      tool('message-review', { type: 'message', sessions: [202], message: 'Check delayed provider responses too.' },
        { session: review, messageId, delivery: 'queued' }),
      wait,
    ] : []),
    ...(incoming ? [record('wait-reply-result', 'tool_result', '', { toolId: call.toolId ?? null, agent: returned, timestamp: at(1000) })] : []),
    ...(done ? [record('parent-reply', 'assistant', 'The atomic claim now protects both requests. The two concurrent-request regressions pass.',
      { assistantPhase: 'final', timestamp: at() })] : []),
  ];
  const sessions = started ? [
    { ...childWork(review, incoming ? 'completed' : failed ? 'error' : 'running', incoming ? 'Two requests can race before the original claim.' : failed ? 'The harness reached its rate limit. Try again when capacity is available.' : 'Reading retry-claims.ts'), ...(incoming ? { delivered: [messageId] } : {}) },
    childWork(tests, waiting ? 'waiting' : done ? 'completed' : 'running', waiting ? 'Choose how long the retry claim should remain valid.' : done ? 'Both concurrent-request regressions pass.' : 'Running the concurrency tests'),
    childWork(docs, 'completed', 'Confirmed the provider retains keys for 24 hours.'),
    ...(scene === 'harnesses' ? [childWork(openCode, 'running', 'Reading the provider fallback')] : []),
  ] : [];
  const base = previewChatState();
  chat.seed(101, { items, state: { ...base, provider: 'claude', providerLocked: true, model: 'Opus', nativeAgentInspection: true,
    phase: done ? 'idle' : 'running', canInterrupt: !done, ...(!done ? { activePromptId: items[0]!.id } : {}),
    work: { running: [], recent: started ? [{ id: 'native:done', kind: 'finished', tone: 'success', title: 'Audit the callback paths',
      detail: 'The callback preserves the original retry key.', agentId: 'native-inspect', agentStatus: 'completed', at: at(5000) }] : [],
    sessions },
  } });
  const brief = 'Trace the retry claim from the request to the provider callback.\n\n' +
    'Reproduce two calls with the same idempotency key. Inspect when the claim is written, confirm which call owns it, and include delayed successes in the checks.\n\n' +
    'Report what you find, the smallest safe change, and how to verify it. Coordinate edits with the other agent working on regression coverage.';
  const child = (ref: SessionAgentReference, state: Partial<SessionChatState>, isReview = false) => {
    const assignment = record('child-brief-' + ref.sessionId, 'user', isReview ? brief.repeat(3) : brief,
      { sender: { session: parent, purpose: 'assignment' } });
    const childItems = [assignment];
    if (isReview && incoming) {
      childItems.push(record('child-message', 'user', 'Check delayed provider responses too.', { sender: { session: parent, purpose: 'message', messageId } }));
      childItems.push(record('review-reply', 'assistant', reply, { assistantPhase: 'final' }));
    }
    chat.seed(ref.sessionId, { items: childItems, state: { ...base, providerLocked: true,
      delegation: { parent, selection: ref.selection, ...(isReview && !incoming ? { parentWaiting: true } : {}),
        ...(isReview && incoming ? { returns: [{ itemId: 'review-reply', recipient: parent, at: at() }] } : {}) }, ...state,
    } });
  };
  child(review, { phase: incoming ? 'idle' : 'running', canInterrupt: !incoming }, true);
  child(tests, { phase: waiting ? 'waiting' : 'running', canInterrupt: true,
    permission: waiting ? { id: 'agent-approval', title: 'Run payment regression tests', description: 'The test command needs your approval.',
      input: '{"command":"pnpm test retry-claims --runInBand"}', allowAlways: false } : null });
  child(docs, { phase: 'idle' });
  if (scene === 'harnesses') child(openCode, { provider: 'opencode', model: openCode.selection.model, phase: 'running', canInterrupt: true });
  const parentRow: WorkspaceSession = { id: 101, taskId: 11, repoId: 1, name: parent.title, provider: 'claude', status: done ? 'done' : 'running', updatedAt: at(),
    ...(started ? { childSummary: { status: waiting ? 'attention' : failed ? 'failed' : 'running', count: waiting || failed || incoming ? 1 : 2 },
      activeChildAgents: incoming || failed ? [203] : [202, 203] } : {}) };
  return [parentRow, ...sessions.map(({ session, status, detail }): WorkspaceSession => ({
    id: session.sessionId, taskId: 11, repoId: 1, name: session.title ?? 'Agent session', provider: session.selection?.provider ?? 'codex',
    status: status === 'waiting' ? 'attention' : status === 'completed' ? 'done' : status === 'error' ? 'failed' : 'running',
    parentSessionId: 101, delegatedBy: parent, agentSelection: session.selection, delegationDetail: detail, updatedAt: at(),
  }))];
}
