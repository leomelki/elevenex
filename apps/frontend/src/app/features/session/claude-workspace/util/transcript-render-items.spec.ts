import { describe, expect, it } from 'vitest';
import type { ClaudeTranscriptItem } from '@/shared/models/claude-runtime.model';
import { pairTranscript } from './paired-transcript';
import { buildTranscriptRenderItems } from './transcript-render-items';

function item(
  id: string,
  kind: ClaudeTranscriptItem['kind'],
  extra: Partial<ClaudeTranscriptItem> = {},
): ClaudeTranscriptItem {
  return { id, kind, content: id, timestamp: '2026-09-30T08:00:00.000Z', ...extra };
}

const work = [
  item('prompt', 'user'),
  item('commentary', 'assistant'),
  item('work-thinking', 'thinking'),
  item('tool', 'tool_use', { toolName: 'Bash', toolUseId: 'tool' }),
  item('result', 'tool_result', { toolUseId: 'tool' }),
];

function render(items: ClaudeTranscriptItem[], settled = true) {
  return buildTranscriptRenderItems({
    units: pairTranscript(items),
    settled,
    childItemsByParentToolUseId: {},
    subagents: [],
    hookEvents: [],
  });
}

describe('buildTranscriptRenderItems final outputs', () => {
  it.each([
    ['adjacent replies', []],
    ['a system notice', [item('notice', 'system')]],
    [
      'a task notification',
      [
        item('notification', 'user', {
          content:
            '<task-notification><task-id>task-1</task-id><status>completed</status><summary>Done</summary></task-notification>',
        }),
      ],
    ],
    ['a synthetic user message', [item('synthetic', 'user', { isSynthetic: true })]],
  ] as const)('keeps all final outputs visible with %s', (_label, between) => {
    const output = [
      item('first-output', 'assistant'),
      ...between,
      item('second-output', 'assistant'),
      item('third-output', 'assistant'),
    ];
    const rendered = render([...work, ...output]);

    expect(rendered.filter((entry) => entry.kind === 'unit').map((entry) => entry.id)).toEqual([
      'prompt',
      ...output.map((entry) => entry.id),
    ]);
    const collapsed = rendered.find((entry) => entry.kind === 'collapsed-turn');
    expect(
      collapsed?.kind === 'collapsed-turn' && collapsed.hiddenUnits.map((unit) => unit.id),
    ).toEqual(['commentary', 'work-thinking', 'tool']);
  });

  it('keeps thinking attached to the first final output and measures through the last output', () => {
    const rendered = render([
      ...work,
      item('final-thinking', 'thinking', { sourceMessageId: 'final-1' }),
      item('first-output', 'assistant', { sourceMessageId: 'final-1' }),
      item('second-thinking', 'thinking', { sourceMessageId: 'final-2' }),
      item('second-output', 'assistant', {
        sourceMessageId: 'final-2',
        receivedAt: '2026-09-30T08:00:12.000Z',
      }),
    ]);

    expect(rendered.filter((entry) => entry.kind === 'unit').map((entry) => entry.id)).toEqual([
      'prompt',
      'final-thinking',
      'first-output',
      'second-thinking',
      'second-output',
    ]);
    expect(rendered.find((entry) => entry.kind === 'collapsed-turn')).toMatchObject({
      durationLabel: '12s',
      stepCount: 3,
    });
  });

  it('keeps the current work expanded while streaming multiple output messages', () => {
    const rendered = render(
      [...work, item('first-output', 'assistant'), item('second-output', 'assistant')],
      false,
    );
    expect(rendered.every((entry) => entry.kind === 'unit')).toBe(true);
    expect(rendered.map((entry) => entry.id)).toEqual([
      'prompt',
      'commentary',
      'work-thinking',
      'tool',
      'first-output',
      'second-output',
    ]);
  });

  it('keeps every output of a completed turn visible while the next turn runs', () => {
    const rendered = render(
      [
        ...work,
        item('first-output', 'assistant'),
        item('second-output', 'assistant'),
        item('next-prompt', 'user'),
        item('next-tool', 'tool_use', { toolName: 'Read' }),
      ],
      false,
    );
    expect(rendered.map((entry) => entry.id)).toEqual([
      'prompt',
      'collapsed-prompt',
      'first-output',
      'second-output',
      'next-prompt',
      'next-tool',
    ]);
  });
});
