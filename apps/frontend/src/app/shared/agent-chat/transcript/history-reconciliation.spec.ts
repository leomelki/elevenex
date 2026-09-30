import type { AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import { describe, expect, it } from 'vitest';
import { reconcileHistoryIdentities } from './history-reconciliation';

function assistant(id: string, timestamp: string, legacy = false): AgentTranscriptItem {
  return {
    id,
    sourceMessageId: id,
    kind: 'assistant',
    content: 'Done.',
    timestamp,
    ...(legacy ? { transcriptMessageId: 'codex-record:2' } : {}),
  };
}

describe('legacy history reconciliation', () => {
  it('matches a synthetic Codex history id to its live copy', () => {
    const history = [assistant('codex-history:2:message', '2', true)];
    const live = [assistant('runtime-id', '2')];
    expect(reconcileHistoryIdentities(history, live)[0].sourceMessageId).toBe('runtime-id');
  });

  it('does not match the same text from a different user turn', () => {
    const history: AgentTranscriptItem[] = [
      { id: 'u1', kind: 'user', timestamp: '1' },
      assistant('codex-history:2:message', '2', true),
      { id: 'u2', kind: 'user', timestamp: '3' },
    ];
    expect(
      reconcileHistoryIdentities(history, [assistant('new-reply', '4')])[1].sourceMessageId,
    ).toBe('codex-history:2:message');
  });

  it('consumes each live copy only once', () => {
    const history = [
      assistant('codex-history:2:message', '2', true),
      assistant('codex-history:3:message', '3', true),
    ];
    const result = reconcileHistoryIdentities(history, [assistant('live', '2')]);
    expect(result.map((item) => item.sourceMessageId)).toEqual(['live', 'codex-history:3:message']);
  });

  it('preserves provider identities when the messages are not legacy recordings', () => {
    expect(
      reconcileHistoryIdentities([assistant('saved', '2')], [assistant('live', '2')])[0]
        .sourceMessageId,
    ).toBe('saved');
  });
});
