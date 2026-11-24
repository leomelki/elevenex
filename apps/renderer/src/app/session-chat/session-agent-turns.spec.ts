import type { SessionAgentReference, SessionAgentTurnEntry, SessionChatState } from '@elevenex/shared';
import { describe, expect, it } from 'vitest';
import type { ChatExchange, WorkStep } from '../conversation';
import { SessionAgentTurnProjection } from './session-agent-turns';

const at = '2026-11-24T02:00:00.000Z';
const later = '2026-11-24T02:02:00.000Z';
const child: SessionAgentReference = { sessionId: 7, taskId: 4, title: 'Review retries', selection: { provider: 'codex', model: 'worker' } };
const launch: SessionAgentTurnEntry = { id: 'launch', at, operation: { type: 'launch', title: child.title, requestId: 'review' } };
const step = (entry: SessionAgentTurnEntry, id = entry.id): WorkStep => ({ id, kind: 'tool', agentEntry: entry });
const exchange = (steps: readonly WorkStep[], status: ChatExchange['status'] = 'live'): ChatExchange =>
  ({ id: 'turn', prompt: 'Review', status, steps, answer: '' });

describe('session agent turn projection', () => {
  it('retains the first card through a launch retry, mixes in native work and keeps reply chronology', () => {
    const accepted = { ...launch, id: 'retry', endedAt: at, result: { session: child, status: 'running' as const } };
    const native = { id: 'native', at, endedAt: at, operation: { type: 'native' as const, title: 'Search earlier decisions' },
      result: { agentId: 'agent-a', status: 'completed' as const } };
    const wait = { id: 'wait', at, operation: { type: 'wait' as const, sessions: [7] } };
    const projector = new SessionAgentTurnProjection();
    const pending = projector.project([exchange([step(launch)])], null)[0]!;
    expect(pending.steps[0]?.agentBoard?.agents).toMatchObject([{ id: 'launch', status: 'pending' }]);
    const waiting = projector.project([exchange([step(launch), step(accepted), step(native), step(wait)])], null)[0]!;
    expect(waiting.steps).toHaveLength(1);
    expect(waiting.steps[0]?.agentBoard).toMatchObject({
      agents: [{ id: 'launch', title: 'Review retries' }, { id: 'native', title: 'Search earlier decisions' }],
      wait: 'Waiting for Review retries', waiting: true,
    });
    const returned = { ...wait, endedAt: later, result: { session: child, status: 'completed' as const,
      reply: { id: 'answer', text: '**Checked.**', truncated: false } } };
    const comment = { id: 'narration', kind: 'say' as const, text: 'Continuing independently.' };
    const result = projector.project([exchange([step(launch), step(accepted), step(native), step(wait), comment, step(returned, 'receipt')])], null, 4)[0]!;
    expect(result.steps.map(row => row.id)).toEqual(['launch', 'narration', 'receipt']);
    expect(result.steps[0]?.agentBoard?.agents[0]).toMatchObject({ id: 'launch', status: 'completed' });
    expect(result.steps[2]?.agentReply).toMatchObject({ replyId: 'answer', text: '**Checked.**' });
  });

  it('updates just the affected turn when a child delivers a queued message', () => {
    const reply = { ...launch, endedAt: at, result: { session: child, status: 'running' as const } };
    const message = { id: 'message', at, endedAt: at, operation: { type: 'message' as const, sessions: [7], message: 'Check the timeout.' },
      result: { messageId: 'send-id', delivery: 'queued' as const, session: child } };
    const annotated = exchange([step(reply), step(message)]);
    const ordinary = { ...exchange([]), id: 'ordinary' };
    const streams = (delivered: readonly string[]): Pick<SessionChatState, 'provider' | 'work'> => ({ provider: 'codex', work: {
      sessions: [{ session: child, status: 'running', detail: '', startedAt: at, endedAt: null, delivered }],
      running: [], recent: [],
    } });
    const projector = new SessionAgentTurnProjection();
    const before = projector.project([ordinary, annotated], streams([]), 4);
    const after = projector.project([ordinary, annotated], streams(['send-id']), 4);
    expect(before[0]).toBe(after[0]);
    expect(before[1]?.agentCards?.[0]?.messages?.[0]?.status).toBe('Queued');
    expect(after[1]?.agentCards?.[0]?.messages?.[0]?.status).toBe('Delivered');
    expect(projector.project([ordinary, annotated], streams(['send-id']), 4)[1]).toBe(after[1]);
  });
});
