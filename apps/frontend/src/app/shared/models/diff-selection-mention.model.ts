import type {
  ChangeReviewFileStatus,
  ChangeReviewScope,
  ChangeReviewRowType,
} from './change-review.model';
import type { PreviewSourceRef } from './review-preview-bridge.model';

export type DiffSelectionMentionScope = ChangeReviewScope | 'conflicts';
export type DiffSelectionMentionStatus = ChangeReviewFileStatus | 'conflicted';

export interface DiffSelectionMentionContextRow {
  type: ChangeReviewRowType;
  oldLine: number | null;
  newLine: number | null;
  content: string;
  oldContent?: string;
}

export interface DiffSelectionMention {
  id: string;
  version: 1;
  scope: DiffSelectionMentionScope;
  compareLabel: string | null;
  baseSha: string | null;
  headSha: string | null;
  filePath: string;
  oldPath: string | null;
  status: DiffSelectionMentionStatus;
  changeHash: string | null;
  oldLineStart: number | null;
  oldLineEnd: number | null;
  newLineStart: number | null;
  newLineEnd: number | null;
  selectedText: string;
  context: {
    before: DiffSelectionMentionContextRow[];
    selected: DiffSelectionMentionContextRow[];
    after: DiffSelectionMentionContextRow[];
  };
  truncated: boolean;
  /**
   * How a rendered preview found this selection, when one made it.
   *
   * Rides along in the anchor JSON, which is already JSON, so it costs nothing
   * and older anchors simply lack it. Deliberately omitted from the plaintext
   * form sent to the agent — that keeps carrying file, lines and text. It
   * exists so a preview can re-find an anchor it created, including the DOM
   * anchors a target with no source lines will produce.
   */
  previewAnchor?: PreviewSourceRef;
}

export const DIFF_SELECTION_MENTION_MAX_FILES = 5;
export const DIFF_SELECTION_MENTION_MAX_TEXT = 8_000;
