import {
  DIFF_SELECTION_MENTION_MAX_TEXT,
  type DiffSelectionMention,
  type DiffSelectionMentionContextRow,
  type DiffSelectionMentionScope,
} from '@/shared/models/diff-selection-mention.model';

/** Source lines kept either side of the selection, matching the diff panel. */
const CONTEXT_LINES = 3;
/** Cap on anchored rows, so selecting a whole document stays manageable. */
const MAX_SELECTED_ROWS = 60;
/** Below this length a line is too generic to trust as a containment match. */
const MIN_FUZZY_MATCH_CHARS = 4;

/** 1-based, inclusive range of source lines a rendered selection covers. */
export interface MarkdownSourceRange {
  startLine: number;
  endLine: number;
}

/**
 * Map a selection made on rendered markdown back onto the source file.
 *
 * Rendering drops the syntax, so the match is made on both sides stripped of
 * inline markers. Anything that cannot be located confidently returns null —
 * a discussion anchored to the wrong lines is worse than one with no lines.
 */
export function locateMarkdownSelection(
  content: string,
  selectedText: string,
): MarkdownSourceRange | null {
  const sourceLines = splitLines(content).map(normalizeLine);
  const selectionLines = splitLines(selectedText).map(normalizeLine).filter(Boolean);
  if (!sourceLines.length || !selectionLines.length) return null;

  const start = findLine(sourceLines, selectionLines[0], 0);
  if (start === null) return null;
  if (selectionLines.length === 1) {
    return { startLine: start + 1, endLine: start + 1 };
  }

  const end = findLine(sourceLines, selectionLines[selectionLines.length - 1], start);
  return { startLine: start + 1, endLine: (end ?? start) + 1 };
}

/**
 * Build a selection mention for a rendered markdown file.
 *
 * `selectedText` stays exactly what the user selected: a mis-located range only
 * costs line numbers, never the quoted text. Base/head shas are omitted because
 * the preview shows the working-tree file rather than a comparison.
 */
export function buildMarkdownSelectionMention(options: {
  filePath: string;
  scope: DiffSelectionMentionScope;
  changeHash: string | null;
  content: string;
  selectedText: string;
}): DiffSelectionMention | null {
  const raw = options.selectedText.replace(/\r\n?/g, '\n').trim();
  if (!raw) return null;

  const sourceLines = splitLines(options.content);
  const range = locateMarkdownSelection(options.content, raw);

  return {
    id: `md-mention-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    version: 1,
    scope: options.scope,
    compareLabel: null,
    baseSha: null,
    headSha: null,
    filePath: options.filePath,
    oldPath: null,
    status: 'modified',
    changeHash: options.changeHash,
    oldLineStart: range?.startLine ?? null,
    oldLineEnd: range?.endLine ?? null,
    newLineStart: range?.startLine ?? null,
    newLineEnd: range?.endLine ?? null,
    selectedText: raw.slice(0, DIFF_SELECTION_MENTION_MAX_TEXT),
    context: {
      before: range ? contextRows(sourceLines, range.startLine - CONTEXT_LINES, range.startLine - 1) : [],
      selected: range
        ? contextRows(sourceLines, range.startLine, range.endLine).slice(0, MAX_SELECTED_ROWS)
        : [{ type: 'context', oldLine: null, newLine: null, content: raw }],
      after: range ? contextRows(sourceLines, range.endLine + 1, range.endLine + CONTEXT_LINES) : [],
    },
    truncated: raw.length > DIFF_SELECTION_MENTION_MAX_TEXT,
  };
}

/** Rows for a 1-based, inclusive line range, clamped to the file. */
function contextRows(
  sourceLines: readonly string[],
  startLine: number,
  endLine: number,
): DiffSelectionMentionContextRow[] {
  const rows: DiffSelectionMentionContextRow[] = [];
  const from = Math.max(1, startLine);
  const to = Math.min(sourceLines.length, endLine);
  for (let line = from; line <= to; line += 1) {
    rows.push({
      type: 'context',
      oldLine: line,
      newLine: line,
      content: sourceLines[line - 1],
    });
  }
  return rows;
}

function findLine(
  sourceLines: readonly string[],
  needle: string,
  fromIndex: number,
): number | null {
  for (let index = fromIndex; index < sourceLines.length; index += 1) {
    const line = sourceLines[index];
    if (!line) continue;
    if (line === needle) return index;
    if (needle.length >= MIN_FUZZY_MATCH_CHARS && line.includes(needle)) return index;
    // The renderer joins soft-wrapped lines, so a selected line can be longer
    // than the source line it came from.
    if (line.length >= MIN_FUZZY_MATCH_CHARS && needle.includes(line)) return index;
  }
  return null;
}

function splitLines(value: string): string[] {
  return value.replace(/\r\n?/g, '\n').split('\n');
}

/** Strip the markdown syntax the renderer removes, so both sides compare alike. */
function normalizeLine(value: string): string {
  return value
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s{0,3}>\s?/, '')
    .replace(/^\s{0,3}([-*+]|\d+\.)\s+/, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
