/** File windows and explicit exceptions keep commits bounded across large repositories. */
export interface WorkspaceCommitSelection {
  readonly includeUnstaged: boolean;
  readonly excluded: readonly string[];
  readonly includedSecrets: readonly string[];
}
export interface WorkspaceCommitFile {
  readonly path: string;
  readonly status: string;
  readonly add: number;
  readonly del: number;
  readonly staged: boolean;
  readonly flag?: "secrets";
}
export interface WorkspaceCommitQuery extends WorkspaceCommitSelection {
  readonly taskId: number;
  readonly query?: string;
  readonly cursor?: string;
}
export interface WorkspaceCommitPreview {
  readonly taskId: number;
  readonly revision: string;
  readonly items: readonly WorkspaceCommitFile[];
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
