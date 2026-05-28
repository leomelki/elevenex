import { describe, expect, it } from 'vitest';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';
import {
  DIFF_SELECTION_MENTION_TAG,
  appendDiffSelectionMentions,
  parseDiffSelectionMentions,
  serializeDiffSelectionMention,
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
    const content = appendDiffSelectionMentions('Review this selection.', [
      mention({
        context: {
          before: [{ type: 'context', oldLine: 7, newLine: 7, content: 'const before = false;' }],
          selected: [{ type: 'add', oldLine: null, newLine: 8, content: 'const next = true;' }],
          after: [{ type: 'context', oldLine: 9, newLine: 9, content: 'return next;' }],
        },
      }),
    ]);
    const parsed = parseDiffSelectionMentions(content);

    expect(content).toContain(`<${DIFF_SELECTION_MENTION_TAG}>`);
    expect(content).toContain('File: src/app.ts');
    expect(content).toContain('Selected text:\nconst next = true;');
    expect(content).not.toContain('"baseSha"');
    expect(content).not.toContain('"changeHash"');
    expect(parsed.text).toBe('Review this selection.');
    expect(parsed.mentions).toHaveLength(1);
    expect(parsed.mentions[0]?.filePath).toBe('src/app.ts');
    expect(parsed.mentions[0]?.selectedText).toBe('const next = true;');
    expect(parsed.mentions[0]?.context.before[0]?.content).toBe('const before = false;');
    expect(parsed.mentions[0]?.context.after[0]?.content).toBe('return next;');
    expect(parseDiffSelectionMentions(content).mentions[0]?.id).toBe(parsed.mentions[0]?.id);
  });

  it('serializes mention blocks as compact plaintext instead of json', () => {
    const content = serializeDiffSelectionMention(mention());

    expect(content).toContain('File: src/app.ts');
    expect(content).toContain('Lines: +8 / -7');
    expect(content).toContain('Status: modified');
    expect(content).not.toContain('{"id"');
    expect(content).not.toContain('"selectedText"');
  });

  it('restores multiline old and new ranges from plaintext mention blocks', () => {
    const content = serializeDiffSelectionMention(
      mention({ oldLineStart: 7, oldLineEnd: 9, newLineStart: 8, newLineEnd: 10 }),
    );
    const parsed = parseDiffSelectionMentions(content).mentions[0];

    expect(parsed?.oldLineStart).toBe(7);
    expect(parsed?.oldLineEnd).toBe(9);
    expect(parsed?.newLineStart).toBe(8);
    expect(parsed?.newLineEnd).toBe(10);
  });

  it('still parses legacy json mention blocks', () => {
    const legacy = `<${DIFF_SELECTION_MENTION_TAG}>${JSON.stringify(mention())}</${DIFF_SELECTION_MENTION_TAG}>`;
    const parsed = parseDiffSelectionMentions(`Review this\n${legacy}`);

    expect(parsed.text).toBe('Review this');
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
