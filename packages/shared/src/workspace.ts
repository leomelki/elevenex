import type { WorkspaceCommitSelection } from './workspace-commit';
export * from './workspace-commit';
/** Bounded workspace resources. IDs belong to the backend scope that supplied them. */
export interface WorkspacePage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
export interface WorkspacePageQuery {
  readonly limit?: number;
  readonly cursor?: string;
}
export interface WorkspaceProject {
  readonly id: number;
  readonly name: string;
  readonly agentInstructions: string | null;
  readonly appearance?: WorkspaceAppearance;
}
export interface WorkspaceRepository {
  readonly id: number;
  readonly projectId: number;
  readonly name: string;
  readonly path: string;
  readonly defaultBase: string | null;
}
export interface WorkspaceProjectDetail {
  readonly project: WorkspaceProject;
  readonly repositories: WorkspacePage<WorkspaceRepository>;
}
export interface WorkspaceTask {
  /** Optional for older runtimes; counts repositories in this task's project. */
  readonly projectRepositoryCount?: number;
  readonly projectName?: string;
  readonly repoName?: string;
  readonly setupIssue?: WorkspaceTaskSetupIssue;
  readonly id: number;
  readonly projectId: number;
  readonly repoId: number;
  readonly name: string;
  readonly branchName: string;
  readonly stage: WorkspaceStage;
  readonly state:
    | 'preparing'
    | 'ready'
    | 'failed'
    | 'finishing'
    | 'releasing'
    | 'released'
    | 'finished';
  readonly archivedAt: string | null;
  readonly updatedAt: string;
}
export type WorkspaceTaskRecovery = 'use-existing' | 'snapshot' | 'exceed-worktree-limit';
export interface WorkspaceTaskSetupIssue {
  readonly code: 'external-checkout' | 'branch-in-use' | 'environment-busy' | 'other';
  readonly message: string;
  readonly workspacePath?: string;
  readonly canUseSnapshot: boolean;
  readonly canExceedWorktreeLimit?: boolean;
}
export interface WorkspaceSession {
  readonly id: number;
  readonly taskId: number;
  readonly repoId: number;
  readonly name: string;
  readonly status: string;
  readonly provider: string;
  readonly updatedAt: string;
}
export interface WorkspaceTaskQuery extends WorkspacePageQuery {
  readonly projectId: number | null;
  readonly state?: 'active' | 'finished';
}
export interface WorkspaceSessionQuery extends WorkspacePageQuery {
  /** Explicit lifecycle window; omission preserves older callers, including closed-task history. */
  readonly state?: 'normal' | 'archived';
  /** Newest bounded page, still returned in chronological display order. Omission preserves oldest-first callers. */
  readonly order?: 'latest';
  readonly taskId: number;
}
export interface WorkspaceCreateProject {
  readonly name: string;
  readonly path: string;
  readonly additionalPaths?: readonly string[];
  /** Explicit setup intents, matched to path + additionalPaths; omitted by legacy clients. */
  readonly repositorySetup?: readonly WorkspaceRepositorySetup[];
  readonly appearance?: WorkspaceAppearance;
}
export interface WorkspaceRepositorySetup {
  readonly path: string;
  readonly clone?: string;
  readonly initialize?: boolean;
}
export interface WorkspaceCreateTask {
  readonly repoId: number;
  readonly name: string;
  readonly requestId: string;
  readonly branchName?: string;
  readonly baseRef?: string;
  readonly mode?: 'new' | 'existing';
}
export interface WorkspaceCreateSession {
  readonly taskId: number;
  readonly name?: string;
}
export interface WorkspaceRenameTask {
  readonly taskId: number;
  readonly name: string;
}
export interface WorkspaceFinishTask {
  readonly taskId: number;
  readonly confirmStop: boolean;
}
export interface WorkspaceUpdateProject {
  readonly projectId: number;
  readonly name?: string;
  readonly agentInstructions?: string;
  readonly appearance?: WorkspaceAppearance;
}
export type WorkspaceStage = 'planned' | 'active' | 'waiting';
export interface WorkspaceAppearance {
  readonly look?: 'letters' | 'emoji' | 'icon';
  readonly hue?: 'ocean' | 'pine' | 'plum' | 'rust' | 'steel' | 'rose';
  readonly emoji?: string;
  readonly icon?: string;
}
export interface WorkspaceBranchQuery {
  readonly repoId: number;
  readonly query?: string;
  readonly limit?: number;
}
export interface WorkspaceBranch {
  readonly name: string;
  readonly current: boolean;
  readonly isDefault: boolean;
  readonly defaultBase: string | null;
  readonly heldTaskName: string | null;
}
export interface WorkspaceFolderQuery {
  readonly query: string;
  readonly limit?: number;
}
export interface WorkspaceFolder {
  readonly path: string;
  readonly name: string;
  readonly git: string | null;
  readonly dir: boolean;
  readonly clone?: string;
}
export interface WorkspaceSetStage {
  readonly taskId: number;
  readonly stage: WorkspaceStage;
}

export interface WorkspaceAddRepository {
  readonly projectId: number;
  readonly path: string;
}
export interface WorkspaceGitSummary {
  readonly taskId: number;
  readonly branch: string;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
  readonly conflicted: boolean;
  readonly commitPhase?: 'writing' | 'committing' | 'pushing';
}
export type WorkspaceGitAction = { readonly taskId: number } & (
  | { readonly type: 'commit'; readonly message: string; readonly selection?: WorkspaceCommitSelection; readonly revision?: string; readonly push?: boolean }
  | { readonly type: 'push' | 'sync' }
  | { readonly type: 'rename-branch'; readonly branchName: string }
);
export interface WorkspaceClosePreview {
  readonly taskId: number;
  readonly sessions: number;
  readonly running: number;
  readonly terminals: number;
  readonly actions: number;
  readonly unpushed: number;
  readonly uncommitted?: number;
}

export interface WorkspaceArchiveSession {
  readonly taskId: number;
  readonly sessionId: number;
  readonly confirmStop: boolean;
}
export interface WorkspaceRestoreSession {
  readonly taskId: number;
  readonly sessionId: number;
}
