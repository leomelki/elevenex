import { describe, expect, it } from 'vitest';
import {
  buildAgentTimelineEntries,
  buildSessionAgentSummary,
  buildTurnAgentSummary,
} from './agent-deep-dive';
import { agentStatusLabel } from './subagent-status.component';
import type { AgentSubagentState } from '@/shared/models/agent-runtime.model';

const start = '2026-10-12T10:00:00.000Z';
const end = '2026-10-12T10:00:10.000Z';
const later = '2026-10-12T10:01:00.000Z';
const child: AgentSubagentState = {
  agentId: 'child',
  agentType: 'explorer',
  displayName: 'Ada',
  status: 'started',
  executionStatus: 'running',
  prompt: 'Inspect tests',
  parentToolUseId: 'spawn',
  startedAt: start,
  timestamp: later,
};

describe('agent deep dive', () => {
  it('keeps background agents attached to the launching turn after their last update moves past its end', () => {
    const summary = buildTurnAgentSummary(
      'turn',
      start,
      end,
      3,
      [
        child,
        {
          ...child,
          agentId: 'grandchild',
          parentAgentId: 'child',
          startedAt: later,
          parentToolUseId: 'nested',
        },
      ],
      [],
    );
    expect(summary?.agents.map((agent) => agent.agentId)).toEqual(['child', 'grandchild']);
    expect(summary?.agents[0].displayName).toBe('Ada');
  });
  it('includes an existing agent referenced by a follow-up turn and excludes unrelated agents', () => {
    const summary = buildTurnAgentSummary(
      'followup',
      end,
      later,
      1,
      [child, { ...child, agentId: 'other' }],
      [],
      new Set(),
      new Set(['child']),
    );
    expect(summary?.agents.map((agent) => agent.agentId)).toEqual(['child']);
  });
  it('exposes the assignment and lifecycle even when a transcript is unavailable', () => {
    const run = buildSessionAgentSummary([child])!.agents[0];
    expect(buildAgentTimelineEntries(null, run)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'message', label: 'Prompt', content: 'Inspect tests' }),
        expect.objectContaining({ kind: 'event', label: 'Agent still active' }),
      ]),
    );
  });
  it('labels streaming replies as updates and failures as failures', () => {
    const run = buildSessionAgentSummary([child])!.agents[0];
    const payload = {
      subagent: child,
      transcriptAvailable: true,
      history: [
        { id: 'reply', kind: 'assistant' as const, content: 'Checking tests', timestamp: later },
      ],
    };
    expect(buildAgentTimelineEntries(payload, run)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'message', label: 'Latest update' }),
      ]),
    );
    const failed = { ...run, status: 'stopped' as const, executionStatus: 'error' as const };
    expect(buildAgentTimelineEntries(payload, failed).at(-1)).toMatchObject({
      label: 'Agent failed',
      tone: 'destructive',
    });
    expect(agentStatusLabel(failed)).toBe('Failed');
  });
});
