import type { ClaudeTranscriptItem } from '../claude-runtime/claude-runtime.types.js';
import {
  buildExportModel,
  renderMarkdown,
  type ConversationExportMeta,
} from './conversation-export.service.js';

const META: ConversationExportMeta = {
  title: 'Fix it',
  sessionId: 42,
  provider: 'claude',
  branch: 'feature/fix',
  exportedAt: '2026-06-16T00:00:00.000Z',
};

function item(
  partial: Partial<ClaudeTranscriptItem> &
    Pick<ClaudeTranscriptItem, 'id' | 'kind'>,
): ClaudeTranscriptItem {
  return { timestamp: '2026-06-16T00:00:00.000Z', ...partial };
}

// user → thinking → intermediate assistant → write(+result) → edit(+result) → final
const TRANSCRIPT: ClaudeTranscriptItem[] = [
  item({ id: 'u1', kind: 'user', content: 'Please create and tweak a.ts' }),
  item({ id: 't1', kind: 'thinking', content: 'Let me think about it.' }),
  item({ id: 'a1', kind: 'assistant', content: 'Working on it.' }),
  item({
    id: 'tu1',
    kind: 'tool_use',
    toolName: 'Write',
    toolUseId: 'tu1',
    toolInput: { file_path: 'a.ts', content: 'line1\nline2' },
  }),
  item({
    id: 'tr1',
    kind: 'tool_result',
    toolUseId: 'tu1',
    content: 'File created',
  }),
  item({
    id: 'tu2',
    kind: 'tool_use',
    toolName: 'Edit',
    toolUseId: 'tu2',
    toolInput: { file_path: 'a.ts', old_string: 'line1', new_string: 'LINE1' },
  }),
  item({ id: 'tr2', kind: 'tool_result', toolUseId: 'tu2', content: 'edited' }),
  item({ id: 'a2', kind: 'assistant', content: 'Done.' }),
];

const ALL_ON = { includeChanges: true, includeIds: true } as const;

describe('buildExportModel', () => {
  it('splits into a single turn with a final response and per-turn changes', () => {
    const model = buildExportModel(TRANSCRIPT, META);
    expect(model.preamble).toHaveLength(0);
    expect(model.turns).toHaveLength(1);

    const turn = model.turns[0];
    expect(turn.user?.id).toBe('u1');
    expect(turn.finalResponse?.id).toBe('a2');
    // steps = everything except the user message and the final assistant message
    expect(turn.steps.map((s) => s.id)).toEqual([
      't1',
      'a1',
      'tu1',
      'tr1',
      'tu2',
      'tr2',
    ]);
    expect(turn.changes?.files).toBe(1);
    expect(turn.changes?.filesChanged[0].path).toBe('a.ts');
  });

  it('puts leading non-user items into the preamble', () => {
    const model = buildExportModel(
      [item({ id: 's0', kind: 'system', content: 'init' }), ...TRANSCRIPT],
      META,
    );
    expect(model.preamble.map((i) => i.id)).toEqual(['s0']);
    expect(model.turns).toHaveLength(1);
  });
});

describe('renderMarkdown precision', () => {
  const model = buildExportModel(TRANSCRIPT, META);

  it('full includes thinking, tool inputs, tool outputs and change hunks', () => {
    const md = renderMarkdown(model, { precision: 'full', ...ALL_ON });
    expect(md).toContain('precision: full');
    expect(md).toContain('### User');
    expect(md).toContain('[thinking]');
    expect(md).toContain('[assistant]');
    expect(md).toContain('[tool] Write — a.ts');
    expect(md).toContain('input:');
    expect(md).toContain('output:');
    expect(md).toContain('### Response');
    expect(md).toContain('Done.');
    expect(md).toContain('### Changes');
    // edit diff hunk present under full
    expect(md).toContain('- line1');
    expect(md).toContain('+ LINE1');
  });

  it('medium keeps inputs but drops thinking and outputs', () => {
    const md = renderMarkdown(model, { precision: 'medium', ...ALL_ON });
    expect(md).toContain('[assistant]');
    expect(md).toContain('input:');
    expect(md).not.toContain('[thinking]');
    expect(md).not.toContain('output:');
    expect(md).toContain('### Changes');
  });

  it('small keeps only user, final response and changes', () => {
    const md = renderMarkdown(model, { precision: 'small', ...ALL_ON });
    expect(md).toContain('### User');
    expect(md).toContain('### Response');
    expect(md).toContain('### Changes');
    expect(md).not.toContain('### Work');
    expect(md).not.toContain('[tool]');
  });
});

describe('renderMarkdown options', () => {
  const model = buildExportModel(TRANSCRIPT, META);

  it('omits change sections when includeChanges is false', () => {
    const md = renderMarkdown(model, {
      precision: 'full',
      includeChanges: false,
      includeIds: true,
    });
    expect(md).not.toContain('### Changes');
  });

  it('emits {#id} markers only when includeIds is true', () => {
    const withIds = renderMarkdown(model, {
      precision: 'medium',
      includeChanges: true,
      includeIds: true,
    });
    const withoutIds = renderMarkdown(model, {
      precision: 'medium',
      includeChanges: true,
      includeIds: false,
    });
    expect(withIds).toContain('{#u1}');
    expect(withIds).toContain('{#a2}');
    expect(withoutIds).not.toContain('{#');
  });

  it('never emits JSON-escaped newlines inside fenced content', () => {
    const md = renderMarkdown(model, { precision: 'full', ...ALL_ON });
    expect(md).toContain('line1\nline2');
    expect(md).not.toContain('line1\\nline2');
  });
});
