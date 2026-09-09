import {
  DIFF_SELECTION_MENTION_MAX_TEXT,
  type DiffSelectionMention,
  type DiffSelectionMentionScope,
} from '@/shared/models/diff-selection-mention.model';
import type { PreviewSourceRef } from '@/shared/models/review-preview-bridge.model';
import {
  REVIEW_CONTEXT_LINES,
  REVIEW_MAX_SELECTED_ROWS,
  sourceContextRows,
  unlocatedContextRow,
} from './review-source-context';

/**
 * Turn a selection made in the rendered HTML preview into a chat mention.
 *
 * The line numbers come from the bridge, which reads them off the source
 * annotations rather than matching text back onto the file the way markdown
 * has to. When they are absent — script-generated markup, an uninstrumented
 * document — the mention keeps the quoted text and loses only the line
 * numbers, which is exactly what the markdown builder does and what the rest
 * of the pipeline already tolerates.
 */
export function buildHtmlSelectionMention(options: {
  /** The tab's file, used when the bridge does not name one. */
  filePath: string;
  scope: DiffSelectionMentionScope;
  changeHash: string | null;
  /** Lines of the HTML source, or null when it has not been read yet. */
  sourceLines: readonly string[] | null;
  selectedText: string;
  source: PreviewSourceRef | null;
}): DiffSelectionMention | null {
  const raw = options.selectedText.replace(/\r\n?/g, '\n').trim();
  if (!raw) return null;

  const lines = options.source?.kind === 'lines' ? options.source : null;
  // The bridge names the file it is actually showing, which matters once the
  // user has followed a link inside the frame.
  const filePath = options.source?.path ?? options.filePath;
  const sourceLines = options.sourceLines;

  const located = lines && sourceLines ? lines : null;

  return {
    id: `html-mention-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    version: 1,
    scope: options.scope,
    compareLabel: null,
    // The preview shows the working tree rather than a comparison, so there is
    // no old/new distinction and no base to name.
    baseSha: null,
    headSha: null,
    filePath,
    oldPath: null,
    status: 'modified',
    changeHash: options.changeHash,
    oldLineStart: lines?.startLine ?? null,
    oldLineEnd: lines?.endLine ?? null,
    newLineStart: lines?.startLine ?? null,
    newLineEnd: lines?.endLine ?? null,
    selectedText: raw.slice(0, DIFF_SELECTION_MENTION_MAX_TEXT),
    context: {
      before:
        located && sourceLines
          ? sourceContextRows(
              sourceLines,
              located.startLine - REVIEW_CONTEXT_LINES,
              located.startLine - 1,
            )
          : [],
      selected:
        located && sourceLines
          ? sourceContextRows(sourceLines, located.startLine, located.endLine).slice(
              0,
              REVIEW_MAX_SELECTED_ROWS,
            )
          : [unlocatedContextRow(raw)],
      after:
        located && sourceLines
          ? sourceContextRows(
              sourceLines,
              located.endLine + 1,
              located.endLine + REVIEW_CONTEXT_LINES,
            )
          : [],
    },
    truncated: raw.length > DIFF_SELECTION_MENTION_MAX_TEXT,
    // Kept so a DOM anchor can be re-found later. Persisted as JSON alongside
    // the rest of the anchor; the plaintext form sent to the agent ignores it.
    previewAnchor: options.source ?? undefined,
  };
}
