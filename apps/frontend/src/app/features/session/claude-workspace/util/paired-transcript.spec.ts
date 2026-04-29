import { describe, expect, it } from 'vitest';
import { pairTranscript } from './paired-transcript';

describe('pairTranscript', () => {
  it('deduplicates duplicate tool calls by toolUseId and prefers richer history items', () => {
    const units = pairTranscript([
      {
        id: 'msg-1:tool:toolu_1',
        kind: 'tool_use',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
        toolInput: {},
        timestamp: '2026-04-28T08:00:01.000Z',
      },
      {
        id: 'msg-1:tool_use:toolu_1',
        kind: 'tool_use',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
        toolInput: { command: 'pwd' },
        interaction: {
          kind: 'permission',
          decision: 'approved',
          decisionLabel: 'Allow',
          decisionTone: 'ok',
          remember: false,
          createdAt: '2026-04-28T08:00:01.000Z',
          resolvedAt: '2026-04-28T08:00:02.000Z',
        },
        sourceMessageId: 'msg-1',
        timestamp: '2026-04-28T08:00:01.000Z',
      },
      {
        id: 'msg-2:tool_result:toolu_1',
        kind: 'tool_result',
        toolUseId: 'toolu_1',
        content: 'done',
        timestamp: '2026-04-28T08:00:02.000Z',
      },
    ]);

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      kind: 'tool',
      toolUseId: 'toolu_1',
      call: expect.objectContaining({
        id: 'msg-1:tool_use:toolu_1',
        interaction: expect.objectContaining({ decisionLabel: 'Allow' }),
        toolInput: { command: 'pwd' },
      }),
    });
  });

  it('deduplicates duplicate tool results by toolUseId and keeps the richer result', () => {
    const units = pairTranscript([
      {
        id: 'msg-1:tool_use:toolu_1',
        kind: 'tool_use',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
        toolInput: { command: 'pwd' },
        timestamp: '2026-04-28T08:00:01.000Z',
      },
      {
        id: 'msg-2:tool_result:toolu_1',
        kind: 'tool_result',
        toolUseId: 'toolu_1',
        content: 'line 1\nline 2',
        sourceMessageId: 'msg-2',
        timestamp: '2026-04-28T08:00:02.000Z',
      },
      {
        id: 'msg-2:tool:toolu_1',
        kind: 'tool_result',
        toolUseId: 'toolu_1',
        content: 'line 1',
        timestamp: '2026-04-28T08:00:02.000Z',
      },
    ]);

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      kind: 'tool',
      result: expect.objectContaining({
        id: 'msg-2:tool_result:toolu_1',
        content: 'line 1\nline 2',
      }),
    });
  });

  it('keeps distinct toolUseIds as separate tool cards', () => {
    const units = pairTranscript([
      {
        id: 'msg-1:tool_use:toolu_1',
        kind: 'tool_use',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
        toolInput: { command: 'pwd' },
        timestamp: '2026-04-28T08:00:01.000Z',
      },
      {
        id: 'msg-2:tool_use:toolu_2',
        kind: 'tool_use',
        toolUseId: 'toolu_2',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        timestamp: '2026-04-28T08:00:02.000Z',
      },
    ]);

    expect(units).toHaveLength(2);
    expect(units.map((unit) => unit.kind === 'tool' ? unit.toolUseId : null)).toEqual([
      'toolu_1',
      'toolu_2',
    ]);
  });

  it('keeps distinct text blocks of the same assistant message as separate units', () => {
    const units = pairTranscript([
      {
        id: 'msg_abc:assistant:0',
        kind: 'assistant',
        sourceMessageId: 'msg_abc',
        content: 'Let me check this.',
        timestamp: '2026-04-28T08:00:00.000Z',
      },
      {
        id: 'msg_abc:tool_use:toolu_1',
        kind: 'tool_use',
        toolUseId: 'toolu_1',
        toolName: 'Read',
        toolInput: { file_path: '/tmp/x' },
        sourceMessageId: 'msg_abc',
        timestamp: '2026-04-28T08:00:01.000Z',
      },
      {
        id: 'msg_abc:assistant:2',
        kind: 'assistant',
        sourceMessageId: 'msg_abc',
        content: 'Found it.',
        timestamp: '2026-04-28T08:00:02.000Z',
      },
    ]);

    const messages = units.filter((u) => u.kind === 'message');
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.kind === 'message' ? m.item.content : null)).toEqual([
      'Let me check this.',
      'Found it.',
    ]);
  });

  it('dedupes streaming and history copies of the same assistant content block', () => {
    const units = pairTranscript([
      {
        id: 'msg_abc:0',
        kind: 'assistant',
        sourceMessageId: 'msg_abc',
        content: 'Streaming partial',
        timestamp: '2026-04-28T08:00:00.000Z',
      },
      {
        id: 'msg_abc:assistant:0',
        kind: 'assistant',
        sourceMessageId: 'msg_abc',
        content: 'Streaming partial finalized',
        timestamp: '2026-04-28T08:00:00.500Z',
      },
    ]);

    const messages = units.filter((u) => u.kind === 'message');
    expect(messages).toHaveLength(1);
    expect(messages[0].kind === 'message' && messages[0].item.content).toBe(
      'Streaming partial finalized',
    );
  });

  it('keeps distinct thinking blocks of the same assistant message as separate units', () => {
    const units = pairTranscript([
      {
        id: 'msg_abc:thinking:0',
        kind: 'thinking',
        sourceMessageId: 'msg_abc',
        content: 'First thought.',
        timestamp: '2026-04-28T08:00:00.000Z',
      },
      {
        id: 'msg_abc:thinking:2',
        kind: 'thinking',
        sourceMessageId: 'msg_abc',
        content: 'Second thought.',
        timestamp: '2026-04-28T08:00:02.000Z',
      },
    ]);

    const thoughts = units.filter((u) => u.kind === 'thinking');
    expect(thoughts).toHaveLength(2);
    expect(thoughts.map((t) => t.kind === 'thinking' ? t.item.content : null)).toEqual([
      'First thought.',
      'Second thought.',
    ]);
  });

  it('preserves orphan tool result rendering', () => {
    const units = pairTranscript([
      {
        id: 'msg-2:tool_result:toolu_1',
        kind: 'tool_result',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
        content: 'done',
        timestamp: '2026-04-28T08:00:02.000Z',
      },
    ]);

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      kind: 'tool',
      toolUseId: 'toolu_1',
      result: expect.objectContaining({ content: 'done' }),
    });
  });
});
