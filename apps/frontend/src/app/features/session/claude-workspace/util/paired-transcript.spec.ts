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

  it('keeps both thinking and assistant text blocks that share a sourceMessageId', () => {
    const units = pairTranscript([
      {
        id: 'msg_abc:thinking:0',
        kind: 'thinking',
        content: 'A long internal monologue that is much longer than the visible text reply.',
        sourceMessageId: 'msg_abc',
        timestamp: '2026-04-28T08:00:01.000Z',
      },
      {
        id: 'msg_abc:assistant:0',
        kind: 'assistant',
        content: 'Let me look at the changed files.',
        sourceMessageId: 'msg_abc',
        timestamp: '2026-04-28T08:00:02.000Z',
      },
    ]);

    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({ kind: 'thinking' });
    expect(units[1]).toMatchObject({
      kind: 'message',
      item: expect.objectContaining({ content: 'Let me look at the changed files.' }),
    });
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

  it('dedupes streaming text after a thinking block against the history-replay copy', () => {
    // Reproduces the production case: when a model emits thinking → text within one
    // Anthropic message, streaming gives the text id `msg_abc:1` (real content-block
    // index) but JSONL history splits each block onto its own line whose `content`
    // array has length 1, so replay assigns it `msg_abc:assistant:0`. Both refer to the
    // same block and must collapse, otherwise the text re-renders after every reload.
    const units = pairTranscript([
      {
        id: 'msg_abc:thinking:0',
        kind: 'thinking',
        sourceMessageId: 'msg_abc',
        content: 'Let me think through this.',
        timestamp: '2026-04-28T08:00:00.000Z',
      },
      {
        id: 'msg_abc:1',
        kind: 'assistant',
        sourceMessageId: 'msg_abc',
        content: 'Streaming reply',
        timestamp: '2026-04-28T08:00:00.500Z',
      },
      {
        id: 'msg_abc:assistant:0',
        kind: 'assistant',
        sourceMessageId: 'msg_abc',
        content: 'Streaming reply finalized from history',
        timestamp: '2026-04-28T08:00:01.000Z',
      },
    ]);

    const messages = units.filter((u) => u.kind === 'message');
    expect(messages).toHaveLength(1);
    expect(messages[0].kind === 'message' && messages[0].item.content).toBe(
      'Streaming reply finalized from history',
    );
  });

  it('keeps both thinking and assistant text blocks that share a sourceMessageId', () => {
    const units = pairTranscript([
      {
        id: 'msg_abc:thinking:0',
        kind: 'thinking',
        content: 'A long internal monologue that is much longer than the visible text reply.',
        sourceMessageId: 'msg_abc',
        timestamp: '2026-04-28T08:00:01.000Z',
      },
      {
        id: 'msg_abc:assistant:0',
        kind: 'assistant',
        content: 'Let me look at the changed files.',
        sourceMessageId: 'msg_abc',
        timestamp: '2026-04-28T08:00:02.000Z',
      },
    ]);

    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({ kind: 'thinking' });
    expect(units[1]).toMatchObject({
      kind: 'message',
      item: expect.objectContaining({ content: 'Let me look at the changed files.' }),
    });
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
