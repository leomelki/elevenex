import type {
  ChangeReviewFileStatus,
  ChangeReviewRowType,
  ChangeReviewScope,
} from './change-review.model';

export interface DiffSelectionMentionContextRow {
  type: ChangeReviewRowType;
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

export interface DiffSelectionMention {
  id: string;
  version: 1;
  scope: ChangeReviewScope;
  compareLabel: string | null;
  baseSha: string | null;
  headSha: string | null;
  filePath: string;
  oldPath: string | null;
  status: ChangeReviewFileStatus;
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
}

export const DIFF_SELECTION_MENTION_MAX_FILES = 5;
export const DIFF_SELECTION_MENTION_MAX_TEXT = 8_000;
