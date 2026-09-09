import type { DiffSelectionMentionContextRow } from '@/shared/models/diff-selection-mention.model';

/**
 * Turning a range of source lines into the context rows a mention carries.
 *
 * Shared by every preview that reads a worktree file and anchors a selection
 * back to its source — markdown today, HTML alongside it. Kept feature-local
 * rather than in `shared/`: it encodes "a preview of a file on disk, anchored
 * to source lines", which is a review-workspace idea, not a generic one.
 */

/** Source lines kept either side of the selection, matching the diff panel. */
export const REVIEW_CONTEXT_LINES = 3;

/** Cap on anchored rows, so selecting a whole document stays manageable. */
export const REVIEW_MAX_SELECTED_ROWS = 60;

export function splitSourceLines(value: string): string[] {
  return value.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * Rows for a 1-based, inclusive line range, clamped to the file.
 *
 * Both `oldLine` and `newLine` carry the source line: a preview shows the
 * working tree rather than a comparison, so there is no old/new distinction —
 * and setting both is what lets `buildAnchorRowIndex` key these rows exactly
 * like diff-made ones, so an anchor created here also lights up in the diff.
 */
export function sourceContextRows(
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

/**
 * The single row a mention falls back to when its lines could not be located.
 *
 * The quoted text always survives; only the line numbers are lost. Downstream
 * (`diffSelectionMentionLineLabel`, `buildGuardedPrompt`) already handles a
 * mention with no line numbers, so this needs no special case anywhere else.
 */
export function unlocatedContextRow(
  selectedText: string,
): DiffSelectionMentionContextRow {
  return { type: 'context', oldLine: null, newLine: null, content: selectedText };
}
