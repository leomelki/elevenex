export interface CommitFile {
  readonly path: string;
  readonly status: string;
  readonly add: number;
  readonly del: number;
  readonly staged: boolean;
  readonly flag?: "secrets";
}
export interface CommitSelection {
  readonly includeUnstaged: boolean;
  readonly excluded: readonly string[];
  readonly includedSecrets: readonly string[];
}
export interface CommitFileWindow {
  readonly revision: string;
  readonly items: readonly CommitFile[];
  readonly nextCursor: string | null;
  readonly matches: number;
  readonly total: number;
  readonly unstaged: number;
  readonly selected: {
    readonly files: number;
    readonly add: number;
    readonly del: number;
    readonly staged: number;
    readonly unstaged: number;
  };
  readonly running: readonly string[];
  readonly runningCount?: number;
}
export type CommitFileProvider = (
  query: CommitSelection & { readonly query: string; readonly cursor?: string },
  signal: AbortSignal,
) => Promise<CommitFileWindow>;
export interface CommitIntent {
  readonly message: string;
  /** Complete selection for supplied-data consumers. Paged owners use selection + revision. */
  readonly files: readonly string[];
  readonly push: boolean;
  readonly selection: CommitSelection;
  readonly revision?: string;
}
