import { pairTranscript } from '@/shared/agent-chat/transcript/paired-transcript';
import { buildTranscriptRenderItems, TurnChangeCache } from '@/shared/agent-chat/transcript/transcript-render-items';
import type { ClaudeTranscriptItem } from '@/shared/models/claude-runtime.model';
import { describe, expect, it } from 'vitest';

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
  it('renders a late filesystem capture after the final response without adding a blank system row', () => {
    const capture = item('capture', 'system', { content: undefined, turnChanges: {
      files: 1, additions: 1, deletions: 0, capture: { root: '/repo', complete: true, shared: false },
      filesChanged: [{ path: 'python.ts', status: 'created', additions: 1, deletions: 0, hunks: [] }],
    } });
    const rendered = render([...work, item('final', 'assistant'), capture]);
    expect(rendered.some(entry => entry.kind === 'unit' && entry.id === 'capture')).toBe(false);
    expect(rendered.find(entry => entry.kind === 'collapsed-turn')).toMatchObject({ changeDetails: { files: 1 } });
    const cache = new TurnChangeCache();
    const tools = pairTranscript(work);
    expect(cache.compute('prompt', tools)).toBeNull();
    expect(cache.compute('prompt', [...tools, ...pairTranscript([capture])])?.files).toBe(1);
  });

  it('shows captured changes for an interrupted turn without an assistant final response', () => {
    const rendered = render([item('prompt', 'user'), item('capture', 'system', { content: undefined, turnChanges: {
      files: 1, additions: 0, deletions: 0, filesChanged: [{ path: 'binary', status: 'modified', additions: 0, deletions: 0, hunks: [] }],
    } })]);
    expect(rendered.find(entry => entry.kind === 'collapsed-turn')).toMatchObject({ changeDetails: { files: 1 } });
  });

  it('keeps failed port-forwarding requests visible in the collapsed activity summary', () => {
    const rendered = render([
      item('prompt', 'user'),
      item('port', 'tool_use', {
        toolUseId: 'port',
        toolName: 'mcp__elevenex__create_port_forward',
        toolInput: { remotePort: 5432 },
      }),
      item('port-result', 'tool_result', {
        toolUseId: 'port',
        isError: false,
        content: JSON.stringify({
          data: {
            forwards: [
              {
                id: 12,
                name: 'Database',
                status: 'error',
                running: false,
                localPort: 5432,
                remotePort: 5432,
                lastError: 'Port occupied',
              },
            ],
          },
        }),
      }),
      item('answer', 'assistant'),
    ]);
    expect(rendered.find((entry) => entry.kind === 'collapsed-turn')).toMatchObject({
      portForwardingAttention: 1,
    });
  });
  it('keeps empty messages inside the active work turn without counting them as steps', () => {
    const rendered = render([
      ...work,
      item('empty', 'user', { content: ' \n\t' }),
      item('next-tool', 'tool_use', { toolUseId: 'next-tool', toolName: 'Read' }),
      item('answer', 'assistant'),
    ]);
    expect(rendered.map((entry) => entry.id)).toEqual(['prompt', 'collapsed-prompt', 'answer']);
    expect(rendered.find((entry) => entry.kind === 'collapsed-turn')).toMatchObject({
      stepCount: 4,
      hiddenUnits: [
        { id: 'commentary' },
        { id: 'work-thinking' },
        { id: 'tool' },
        { id: 'empty' },
        { id: 'next-tool' },
      ],
    });
  });

  it('starts a new turn when a human quotes an injected event', () => {
    const rendered = render([
      ...work,
      item('answer', 'assistant'),
      item('quoted', 'user', {
        content: '```text\n[Image: original 1100x3000, displayed at 733x2000.]\n```',
      }),
      item('next-tool', 'tool_use', { toolUseId: 'next-tool', toolName: 'Read' }),
      item('next-answer', 'assistant'),
    ]);
    expect(
      rendered.filter((entry) => entry.kind === 'collapsed-turn').map((entry) => entry.id),
    ).toEqual(['collapsed-prompt', 'collapsed-quoted']);
  });

  it.each([
    ['skill', 'Base directory for this skill: /repo/.claude/skills/write-tests\n\n# Instructions'],
    [
      'image',
      '[Image: original 1100x3000, displayed at 733x2000. Multiply coordinates by 1.50 to map to original image.]',
    ],
    [
      'task completion',
      '<task-notification><task-id>task-1</task-id><status>completed</status><summary>Done</summary></task-notification>',
    ],
  ])('does not split work at a %s notice', (_label, content) => {
    const rendered = render([
      ...work,
      item('notice', 'user', { content }),
      item('next-tool', 'tool_use', { toolUseId: 'next-tool', toolName: 'Read' }),
      item('answer', 'assistant', { receivedAt: '2026-09-30T08:02:00.000Z' }),
    ]);
    expect(rendered.map((entry) => entry.id)).toEqual(['prompt', 'collapsed-prompt', 'answer']);
    expect(rendered.find((entry) => entry.kind === 'collapsed-turn')).toMatchObject({
      durationLabel: '2m',
      stepCount: 4,
      hiddenUnits: [
        { id: 'commentary' },
        { id: 'work-thinking' },
        { id: 'tool' },
        { id: 'notice' },
        { id: 'next-tool' },
      ],
    });
  });

  it('does not settle an active turn when a task notification arrives', () => {
    const rendered = render(
      [
        ...work,
        item('intermediate', 'assistant'),
        item('notification', 'user', {
          content:
            '<task-notification><task-id>task-1</task-id><summary>Done</summary></task-notification>',
        }),
        item('next-tool', 'tool_use', { toolName: 'Read' }),
      ],
      false,
    );
    expect(rendered.every((entry) => entry.kind === 'unit')).toBe(true);
  });

  it('still starts a turn for human text accompanying an image notice', () => {
    const rendered = render([
      ...work,
      item('answer', 'assistant'),
      item('next-prompt', 'user', {
        content: 'Check this\n[Image: original 1100x3000, displayed at 733x2000.]',
      }),
      item('next-tool', 'tool_use', { toolName: 'Read' }),
      item('next-answer', 'assistant'),
    ]);
    expect(
      rendered.filter((entry) => entry.kind === 'collapsed-turn').map((entry) => entry.id),
    ).toEqual(['collapsed-prompt', 'collapsed-next-prompt']);
  });

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
