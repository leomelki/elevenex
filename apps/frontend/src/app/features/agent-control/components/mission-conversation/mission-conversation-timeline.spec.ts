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
  it('uses the shared Elevenex result model for mission task receipts', () => {
    const rows = buildMissionRows([
      { ...item('call', 'tool_use', '', 0), toolUseId: 'task-call', toolName: 'mcp__elevenex__create_task', toolInput: { name: 'Fix auth' } },
      { ...item('result', 'tool_result', JSON.stringify({ data: { taskId: 9, name: 'Fix auth', state: 'preparing' }, deepLink: '/tasks/9' }), 1), toolUseId: 'task-call' },
    ], []);
    expect(rows[0]).toMatchObject({ category: 'setup', verb: 'Create task', result: { text: 'Preparing', tone: 'warn' }, elevenex: { link: '/tasks/9' } });
  });

  it('shows structured failures and absent responses without a false success state', () => {
    const call = { ...item('call', 'tool_use', '', 0), toolUseId: 'task-call', toolName: 'mcp__elevenex__finish_task' };
    expect(buildMissionRows([call], [], false)[0]).toMatchObject({ status: 'incomplete', result: { text: 'No result recorded' } });
    const response = { ...item('result', 'tool_result', JSON.stringify({ error: { code: 'running_work', message: 'Running work.' } }), 1), toolUseId: 'task-call' };
    expect(buildMissionRows([call, response], [])[0]).toMatchObject({ status: 'error', elevenex: { toolFailed: true }, result: { tone: 'error' } });
  });

});
