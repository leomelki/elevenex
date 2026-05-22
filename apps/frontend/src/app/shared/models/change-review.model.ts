export type ChangeReviewScope = 'uncommitted' | 'last-commit' | 'branch';

export type ChangeReviewFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed';

export interface ChangeReviewPullRequestInfo {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  baseRefName: string | null;
}

export interface ChangeReviewFileSummary {
  path: string;
  oldPath: string | null;
  status: ChangeReviewFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  large: boolean;
  size: number | null;
}

export interface ChangeReviewSummary {
  scope: ChangeReviewScope;
  worktreePath: string;
  repoRoot: string;
  branch: string;
  baseRef: string | null;
  baseSha: string | null;
  headSha: string | null;
  mergeBaseSha: string | null;
  compareLabel: string;
  generatedAt: string;
  staleBase: boolean;
  originRefAgeSeconds: number | null;
  pullRequest: ChangeReviewPullRequestInfo | null;
  totals: {
    files: number;
    additions: number;
    deletions: number;
  };
  files: ChangeReviewFileSummary[];
}

export type ChangeReviewRowType =
  | 'hunk'
  | 'context'
  | 'add'
  | 'delete'
  | 'expand'
  | 'meta';

export interface ChangeReviewRow {
  id: string;
  type: ChangeReviewRowType;
  oldLine: number | null;
  newLine: number | null;
  content: string;
  path: string;
  oldStart?: number;
  newStart?: number;
  count?: number;
}

export interface ChangeReviewContextRange {
  id: string;
  oldStart: number;
  newStart: number;
  count: number;
}

export interface ChangeReviewFileWindow {
  scope: ChangeReviewScope;
  path: string;
  oldPath: string | null;
  status: ChangeReviewFileStatus;
  binary: boolean;
  large: boolean;
  truncated: boolean;
  message: string | null;
  offset: number;
  limit: number;
  totalRows: number;
  hasMore: boolean;
  context: number;
  rows: ChangeReviewRow[];
  contextRanges: ChangeReviewContextRange[];
}

export interface ChangeReviewContextWindow {
  scope: ChangeReviewScope;
  path: string;
  oldStart: number;
  newStart: number;
  count: number;
  limit: number;
  rows: ChangeReviewRow[];
}
