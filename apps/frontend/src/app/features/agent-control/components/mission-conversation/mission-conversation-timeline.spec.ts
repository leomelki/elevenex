import type { ClaudeTranscriptItem } from '@/shared/models/claude-runtime.model';
import { describe, expect, it } from 'vitest';
import { buildMissionGroups, buildMissionRows } from './mission-conversation-timeline';

const item = (
  id: string,
  kind: ClaudeTranscriptItem['kind'],
  content: string,
  seconds: number,
): ClaudeTranscriptItem => ({
  id,
  kind,
  content,
  timestamp: new Date(Date.UTC(2026, 9, 1, 12, 0, seconds)).toISOString(),
});

describe('mission conversation timeline', () => {
  it('keeps final replies inline and folds intermediate work within each user turn', () => {
    const rows = buildMissionRows(
      [
        item('user1', 'user', 'First task', 0),
        item('thinking', 'thinking', 'Considering it', 1),
        item('narration', 'assistant', 'Working', 2),
        item('reply1', 'assistant', 'Done', 5),
        item('user2', 'user', 'Next task', 6),
        item('reply2', 'assistant', 'Done again', 7),
      ],
      [],
    );
    const groups = buildMissionGroups(rows, []);
    expect(groups.map((group) => group.id)).toEqual([
      'user1',
      'cluster-thinking',
      'reply1',
      'user2',
      'reply2',
    ]);
    expect(groups[1]).toMatchObject({
      type: 'cluster',
      actionCount: 0,
      durationLabel: '1s',
      rows: [{ id: 'thinking' }, { id: 'narration' }],
    });
  });

  it('pairs action results and uses the latest summary covering a cluster tool', () => {
    const rows = buildMissionRows(
      [
        {
          ...item('tool', 'tool_use', '', 1),
          toolUseId: 'tool1',
          toolName: 'mcp__elevenex__read_session',
          toolInput: { sessionId: 7 },
        },
        { ...item('result', 'tool_result', 'Session output', 3), toolUseId: 'tool1' },
        item('reply', 'assistant', 'Finished', 5),
      ],
      [],
    );
    expect(rows[0]).toMatchObject({
      type: 'action',
      category: 'observe',
      status: 'ok',
      output: 'Session output',
    });
    const groups = buildMissionGroups(rows, [
      { summary: 'Earlier summary', precedingToolUseIds: ['tool1'], timestamp: '' },
      { summary: 'Latest summary', precedingToolUseIds: ['tool1'], timestamp: '' },
    ]);
    expect(groups[0]).toMatchObject({ type: 'cluster', actionCount: 1, summary: 'Latest summary' });
  });

  it('keeps errors as visible rows separating clusters', () => {
    const rows = buildMissionRows(
      [
        item('before', 'thinking', 'Before', 0),
        item('error', 'error', 'Failed', 1),
        item('after', 'thinking', 'After', 2),
      ],
      [],
    );
    expect(buildMissionGroups(rows, []).map((group) => group.id)).toEqual([
      'cluster-before',
      'error',
      'cluster-after',
    ]);
  });
});
