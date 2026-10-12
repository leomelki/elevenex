import { describe, expect, it } from 'vitest';
import type { AgentSubagentHistoryPayload } from '@/shared/models/agent-runtime.model';
import { mergeAgentHistory } from './agent-history-cache';

describe('agent history pagination', () => {
  it('keeps older pages and preserves exhaustion when refreshing the tail', () => {
    const payload = (ids: number[], hasEarlier?: boolean): AgentSubagentHistoryPayload => ({
      subagent: {
        agentId: 'worker',
        agentType: 'worker',
        status: 'stopped',
        timestamp: '2026-10-12T10:00:00Z',
      },
      transcriptAvailable: true,
      hasEarlier,
      history: ids.map((id) => ({
        id: `message-${id}`,
        kind: 'assistant',
        timestamp: `2026-10-12T10:00:0${id}Z`,
      })),
    });
    const earlier = mergeAgentHistory(payload([2, 3], true), payload([0, 1]), true);
    expect(earlier.hasEarlier).toBe(false);
    const refreshed = mergeAgentHistory(earlier, payload([3, 4], true));
    expect(refreshed.history.map((item) => item.id)).toEqual([
      'message-0',
      'message-1',
      'message-2',
      'message-3',
      'message-4',
    ]);
    expect(refreshed.hasEarlier).toBe(false);
  });
});
