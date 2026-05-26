import { describe, expect, it } from 'vitest';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';
import {
  DIFF_SELECTION_MENTION_TAG,
  appendDiffSelectionMentions,
  parseDiffSelectionMentions,
} from './diff-selection-mention';

const mention = (overrides: Partial<DiffSelectionMention> = {}): DiffSelectionMention => ({
  id: 'mention-1',
  version: 1,
  scope: 'branch',
  compareLabel: 'feature vs origin/main',
  baseSha: 'base',
  headSha: 'head',
  filePath: 'src/app.ts',
  oldPath: null,
  status: 'modified',
  changeHash: 'hash',
  oldLineStart: 7,
  oldLineEnd: 7,
  newLineStart: 8,
  newLineEnd: 8,
  selectedText: 'const next = true;',
  context: {
    before: [],
    selected: [{ type: 'add', oldLine: null, newLine: 8, content: 'const next = true;' }],
    after: [],
  },
  truncated: false,
  ...overrides,
});

describe('diff selection mention prompt blocks', () => {
  it('round-trips mention blocks while preserving visible prompt text', () => {
    const content = appendDiffSelectionMentions('Review this selection.', [mention()]);
    const parsed = parseDiffSelectionMentions(content);

    expect(content).toContain(`<${DIFF_SELECTION_MENTION_TAG}>`);
    expect(parsed.text).toBe('Review this selection.');
    expect(parsed.mentions).toHaveLength(1);
    expect(parsed.mentions[0]?.filePath).toBe('src/app.ts');
    expect(parsed.mentions[0]?.selectedText).toBe('const next = true;');
  });

  it('drops malformed mention blocks from visible text', () => {
    const parsed = parseDiffSelectionMentions(
      `Visible\n<${DIFF_SELECTION_MENTION_TAG}>not json</${DIFF_SELECTION_MENTION_TAG}>`,
    );

    expect(parsed.text).toBe('Visible');
    expect(parsed.mentions).toEqual([]);
  });
});
