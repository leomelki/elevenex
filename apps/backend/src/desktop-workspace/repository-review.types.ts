/** Task-owned read-only repository reviews; reply patches use sessionChatChanges. */
export type RepositoryReviewSource = 'uncommitted' | 'last-commit' | 'branch';
export type RepositoryReviewMode = 'changes' | 'full';
export interface RepositoryReviewQuery {
  readonly taskId: number;
  readonly requestId: string;
  readonly source: RepositoryReviewSource;
  readonly baseRef?: string;
  readonly revision?: string;
  readonly query?: string;
  readonly offset?: number;
  readonly fileId?: string;
  readonly fileRev?: string;
  readonly mode?: RepositoryReviewMode;
  readonly lineOffset?: number;
  readonly context?: number;
  readonly expansions?: readonly {
    readonly hunkId: string;
    readonly before: number;
    readonly after: number;
  }[];
  readonly force?: boolean;
}
export interface RepositoryReviewFile {
  readonly id: string;
  readonly path: string;
  readonly oldPath?: string;
  readonly status: 'A' | 'M' | 'D' | 'R';
  readonly layer: 'staged' | 'unstaged' | 'untracked' | 'committed';
  readonly rev: string;
  readonly add: number;
  readonly del: number;
  readonly binary: boolean;
  readonly large: boolean;
  readonly countsExact: boolean;
  readonly oldRevision: string | null;
  readonly newRevision: string | null;
  readonly oldMode: string;
  readonly newMode: string;
}
export interface RepositoryReviewLine {
  readonly id: string;
  readonly kind: 'context' | 'add' | 'del';
  readonly oldNumber?: number;
  readonly newNumber?: number;
  readonly text: string;
  readonly spans?: readonly {
    readonly text: string;
    readonly token?: 'keyword' | 'string' | 'number' | 'function' | 'comment';
  }[];
}
export interface RepositoryReviewHunk {
  readonly id: string;
  readonly heading: string;
  readonly lines: readonly RepositoryReviewLine[];
  readonly before?: number;
  readonly after?: number;
}
export interface RepositoryReviewContent {
  readonly fileId: string;
  readonly rev: string;
  readonly mode: RepositoryReviewMode;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly hunks: readonly RepositoryReviewHunk[];
  readonly notice?: string;
}
export interface RepositoryReviewPage {
  readonly taskId: number;
  readonly source: RepositoryReviewSource;
  readonly revision: string;
  readonly headSha: string | null;
  readonly baseSha: string | null;
  readonly baseRef: string | null;
  readonly targetSha: string | null;
  readonly fingerprint: string | null;
  readonly explanation: string;
  readonly total: number;
  readonly matched: number;
  readonly additions: number;
  readonly deletions: number;
  readonly countsExact: boolean;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly files: readonly RepositoryReviewFile[];
  readonly content: RepositoryReviewContent | null;
}
export interface RepositoryReviewBranches {
  readonly taskId: number;
  readonly refs: readonly string[];
  readonly hasMore: boolean;
}
export interface RepositoryReviewBranchesQuery {
  readonly taskId: number;
  readonly query: string;
  readonly requestId: string;
}
/** Internal blob/worktree identities never supplied by the renderer. */
export interface RepositoryReviewEntry {
  file: RepositoryReviewFile;
  oldOid: string;
  newOid: string;
  version: string;
}
