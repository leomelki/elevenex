import { describe, expect, it } from 'vitest';
import {
  buildMarkdownSelectionMention,
  locateMarkdownSelection,
} from './review-markdown-selection';

const DOC = [
  '# Title', // 1
  '', // 2
  'An intro paragraph about the thing.', // 3
  '', // 4
  '## Details', // 5
  '', // 6
  'The **important** detail lives here.', // 7
  'A second line of the same idea.', // 8
  '', // 9
  '- a bullet item', // 10
  '- another bullet', // 11
].join('\n');

describe('locateMarkdownSelection', () => {
  it('locates a single rendered line', () => {
    expect(locateMarkdownSelection(DOC, 'An intro paragraph about the thing.')).toEqual({
      startLine: 3,
      endLine: 3,
    });
  });

  it('ignores the markdown syntax the renderer strips', () => {
    // The user selects the rendered text, which has no ** around "important".
    expect(locateMarkdownSelection(DOC, 'The important detail lives here.')).toEqual({
      startLine: 7,
      endLine: 7,
    });
  });

  it('spans from the first to the last selected line', () => {
    const selection = 'Details\n\nThe important detail lives here.\nA second line of the same idea.';

    expect(locateMarkdownSelection(DOC, selection)).toEqual({ startLine: 5, endLine: 8 });
  });

  it('matches a partial selection inside a line', () => {
    expect(locateMarkdownSelection(DOC, 'detail lives')).toEqual({ startLine: 7, endLine: 7 });
  });

  it('finds list items without their bullet markers', () => {
    expect(locateMarkdownSelection(DOC, 'another bullet')).toEqual({
      startLine: 11,
      endLine: 11,
    });
  });

  it('gives up rather than guessing when the text is not in the file', () => {
    expect(locateMarkdownSelection(DOC, 'text that is nowhere in the document')).toBeNull();
  });
});

describe('buildMarkdownSelectionMention', () => {
  const build = (selectedText: string) =>
    buildMarkdownSelectionMention({
      filePath: 'docs/notes.md',
      scope: 'branch',
      changeHash: 'hash-1',
      content: DOC,
      selectedText,
    });

  it('anchors the mention to the located source lines with context', () => {
    const mention = build('The important detail lives here.\nA second line of the same idea.');

    expect(mention).not.toBeNull();
    expect(mention!.filePath).toBe('docs/notes.md');
    expect(mention!.changeHash).toBe('hash-1');
    expect(mention!.newLineStart).toBe(7);
    expect(mention!.newLineEnd).toBe(8);
    expect(mention!.context.selected.map((row) => row.content)).toEqual([
      'The **important** detail lives here.',
      'A second line of the same idea.',
    ]);
    expect(mention!.context.before.map((row) => row.newLine)).toEqual([4, 5, 6]);
    expect(mention!.context.after.map((row) => row.newLine)).toEqual([9, 10, 11]);
  });

  it('keeps the selection usable when the lines cannot be located', () => {
    const mention = build('text that is nowhere in the document');

    expect(mention).not.toBeNull();
    expect(mention!.newLineStart).toBeNull();
    expect(mention!.selectedText).toBe('text that is nowhere in the document');
    expect(mention!.context.selected).toHaveLength(1);
  });

  it('rejects an empty selection', () => {
    expect(build('   \n  ')).toBeNull();
  });
});
