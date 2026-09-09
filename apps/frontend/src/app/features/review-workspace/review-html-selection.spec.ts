import { DIFF_SELECTION_MENTION_MAX_TEXT } from '@/shared/models/diff-selection-mention.model';
import type { PreviewSourceRef } from '@/shared/models/review-preview-bridge.model';
import { buildHtmlSelectionMention } from './review-html-selection';
import { splitSourceLines } from './review-source-context';

const SOURCE = [
  '<html>',
  '<body>',
  '  <h1>Title</h1>',
  '  <p>First paragraph.</p>',
  '  <p>Second paragraph.</p>',
  '</body>',
  '</html>',
].join('\n');

function build(options: {
  source: PreviewSourceRef | null;
  selectedText?: string;
  sourceLines?: readonly string[] | null;
}) {
  return buildHtmlSelectionMention({
    filePath: 'docs/index.html',
    scope: 'branch',
    changeHash: 'hash-1',
    sourceLines: options.sourceLines === undefined ? splitSourceLines(SOURCE) : options.sourceLines,
    selectedText: options.selectedText ?? 'First paragraph.',
    source: options.source,
  });
}

describe('buildHtmlSelectionMention', () => {
  it('returns null for an empty selection', () => {
    expect(build({ source: null, selectedText: '   ' })).toBeNull();
  });

  it('fills both line ranges from a lines anchor', () => {
    const mention = build({
      source: { kind: 'lines', path: 'docs/index.html', startLine: 4, endLine: 4 },
    })!;

    // The preview shows the working tree, not a comparison, so both sides
    // carry the same source range.
    expect(mention.oldLineStart).toBe(4);
    expect(mention.oldLineEnd).toBe(4);
    expect(mention.newLineStart).toBe(4);
    expect(mention.newLineEnd).toBe(4);
  });

  it('carries the real source lines as context', () => {
    const mention = build({
      source: { kind: 'lines', path: 'docs/index.html', startLine: 4, endLine: 4 },
    })!;

    expect(mention.context.selected.map((row) => row.content)).toEqual([
      '  <p>First paragraph.</p>',
    ]);
    expect(mention.context.before.map((row) => row.content)).toEqual([
      '<html>',
      '<body>',
      '  <h1>Title</h1>',
    ]);
    expect(mention.context.after.map((row) => row.content)).toEqual([
      '  <p>Second paragraph.</p>',
      '</body>',
      '</html>',
    ]);
  });

  it('sets both line numbers on context rows, so diff anchoring matches', () => {
    const mention = build({
      source: { kind: 'lines', path: 'docs/index.html', startLine: 4, endLine: 4 },
    })!;

    expect(mention.context.selected[0].oldLine).toBe(4);
    expect(mention.context.selected[0].newLine).toBe(4);
  });

  it('falls back to a single quoted row for a dom anchor', () => {
    const mention = build({
      source: {
        kind: 'dom',
        path: 'docs/index.html',
        nodePath: 'body > p:nth-child(2)',
        nodeId: 7,
        tagName: 'p',
      },
    })!;

    expect(mention.oldLineStart).toBeNull();
    expect(mention.newLineEnd).toBeNull();
    expect(mention.context.before).toEqual([]);
    expect(mention.context.after).toEqual([]);
    expect(mention.context.selected).toEqual([
      { type: 'context', oldLine: null, newLine: null, content: 'First paragraph.' },
    ]);
  });

  it('keeps the quoted text when the source could not be read', () => {
    const mention = build({
      source: { kind: 'lines', path: 'docs/index.html', startLine: 4, endLine: 4 },
      sourceLines: null,
    })!;

    // Line numbers survive; only the surrounding context is lost.
    expect(mention.newLineStart).toBe(4);
    expect(mention.context.selected[0].content).toBe('First paragraph.');
    expect(mention.context.before).toEqual([]);
  });

  it('prefers the path the frame reports over the tab it was opened from', () => {
    const mention = build({
      source: { kind: 'lines', path: 'docs/other.html', startLine: 1, endLine: 1 },
    })!;

    expect(mention.filePath).toBe('docs/other.html');
  });

  it('falls back to the tab path when the anchor names none', () => {
    const mention = build({
      source: { kind: 'dom', path: null, nodePath: 'body', nodeId: null, tagName: 'body' },
    })!;

    expect(mention.filePath).toBe('docs/index.html');
  });

  it('records the anchor so a preview can find it again', () => {
    const source: PreviewSourceRef = {
      kind: 'dom',
      path: 'docs/index.html',
      nodePath: 'body > p:nth-child(2)',
      nodeId: 7,
      tagName: 'p',
    };
    expect(build({ source })!.previewAnchor).toEqual(source);
  });

  it('truncates a very long selection and says so', () => {
    const mention = build({
      source: null,
      selectedText: 'x'.repeat(DIFF_SELECTION_MENTION_MAX_TEXT + 100),
    })!;

    expect(mention.truncated).toBe(true);
    expect(mention.selectedText.length).toBe(DIFF_SELECTION_MENTION_MAX_TEXT);
  });

  it('does not claim a base to compare against', () => {
    const mention = build({ source: null })!;
    expect(mention.baseSha).toBeNull();
    expect(mention.headSha).toBeNull();
    expect(mention.compareLabel).toBeNull();
    expect(mention.changeHash).toBe('hash-1');
  });
});
