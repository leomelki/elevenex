import type {
  ChangeReviewFileStatus,
  ChangeReviewScope,
  ChangeReviewRowType,
} from './change-review.model';

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
}

export const DIFF_SELECTION_MENTION_MAX_FILES = 5;
export const DIFF_SELECTION_MENTION_MAX_TEXT = 8_000;
