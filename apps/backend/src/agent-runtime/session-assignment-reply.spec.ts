import type { AgentTranscriptItem } from './agent-runtime.types.js';
import { sessionAssignmentReply } from './session-assignment-reply.js';
import { sessionAgentPrompt } from '../sessions/session-agent-message.js';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-11-26T00:00:00.000Z';
const prompt = (id: string): AgentTranscriptItem => ({
  id,
  kind: 'user',
  timestamp,
  content: sessionAgentPrompt('Work', { sessionId: 1 }, 'assignment', id),
});
const answer = (id: string): AgentTranscriptItem => ({
  id,
  kind: 'assistant',
  timestamp,
  content: id,
  assistantPhase: 'final',
});

describe('assignment reply ownership', () => {
  it('does not return an older final before the prompt has arrived', () => {
    expect(
      sessionAssignmentReply([prompt(first), answer('old')], second, new Map()),
    ).toBeUndefined();
  });

  it('keeps queued work separate and ignores commentary as a final answer', () => {
    const history = [
      prompt(first),
      { ...answer('progress'), assistantPhase: 'commentary' as const },
      prompt(second),
      answer('second'),
    ];
    expect(
      sessionAssignmentReply(history, first, new Map([[second, 'queued']])),
    ).toBeUndefined();
    expect(sessionAssignmentReply(history, second, new Map())?.id).toBe(
      'second',
    );
  });

  it('shares a final for steering corrections, including provider continuation frames', () => {
    const history: AgentTranscriptItem[] = [
      prompt(first),
      prompt(second),
      { id: 'image', kind: 'user', content: '[Image]', timestamp },
      answer('shared'),
    ];
    const dispositions = new Map([[second, 'steered' as const]]);
    expect(sessionAssignmentReply(history, first, dispositions)?.id).toBe(
      'shared',
    );
    expect(sessionAssignmentReply(history, second, dispositions)?.id).toBe(
      'shared',
    );
  });
});
