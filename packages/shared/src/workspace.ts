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
  /** The creating agent may close this task after collecting its result. */
  readonly temporary?: true;
  /** Optional for older runtimes; counts repositories in this task's project. */
  readonly projectRepositoryCount?: number;
  readonly projectName?: string;
  readonly repoName?: string;
  readonly setupIssue?: WorkspaceTaskSetupIssue;
  /**
   * The current workspace setup step while `preparing`, or the step where a
   * `failed` setup stopped. Omitted by older runtimes and by failures outside
   * setup, such as a missing folder or close cleanup.
   */
  readonly setupStep?: WorkspaceTaskSetupStep;
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
/**
 * Setup runs in this order: `queued` (accepted, not started), `fetching`
 * (refreshing the base from its remote), `waiting` (checkout work is serialized
 * per repository), `checkout` (reserving and checking out the workspace), then
 * `sessions` (restoring or opening conversations).
 */
export type WorkspaceTaskSetupStep = 'queued' | 'fetching' | 'waiting' | 'checkout' | 'sessions';
export type WorkspaceTaskRecovery ='use-existing' | 'snapshot' | 'exceed-worktree-limit' | 'restore-branch' | 'new-workspace';
export interface WorkspaceTaskSetupIssue {
  readonly code: 'external-checkout' | 'branch-in-use' | 'environment-busy' | 'other';
  readonly message: string;
  readonly workspacePath?: string;
  readonly canUseSnapshot: boolean;
  readonly canExceedWorktreeLimit?: boolean;
  /** Cleanup failed during close. Use the close flow to retry. */
  readonly closeFailed?: true;
  /** Optional capability; older clients retain ordinary retry. */
  readonly workspaceRecovery?: 'prepare' | 'restore-branch' | 'new-workspace';
}
export interface WorkspaceSession {
  /** Engine permits permanent removal only before any conversation starts. */
  readonly canDelete?: boolean;
  readonly parentSessionId?: number | null;
  readonly childCount?: number;
  readonly delegatedBy?: import('./session-agents').SessionAgentReference;
  readonly agentSelection?: import('./session-agents').SessionAgentSelection;
  readonly childSummary?: import('./session-agents').SessionChildSummary;
  readonly delegationDetail?: string;
  readonly parentWaiting?: true;
  readonly activeChildAgents?: readonly number[];
  /** Archiving this group requires stopping live subsession work. */
  readonly childStopRequired?: boolean;
  readonly id: number;
  readonly taskId: number;
  readonly repoId: number;
  readonly name: string;
  /** Legacy status: detached commands make a session read as `running`. */
  readonly status: string;
  /** The agent's own state, supplied only while detached commands run. Prefer it over `status`. */
  readonly turnStatus?: string;
  /** Detached shell commands still running. Omitted by older engines and when none run. */
  readonly commandCount?: number;
  readonly provider: string;
  readonly updatedAt: string;
}
export interface WorkspaceTaskQuery extends WorkspacePageQuery {
  readonly projectId: number | null;
  readonly state?: 'active' | 'finished';
}
/** Priority pages can supply the root context for their nested sessions. */
export interface WorkspaceSessionPage extends WorkspacePage<WorkspaceSession> {
  readonly parentSessions?: readonly WorkspaceSession[];
}
export function isWorkspacePriorityStatus(status: string): boolean {
  return status === 'running' || status === 'attention' || status === 'review' || status === 'failed';
}
export interface WorkspaceSessionQuery extends WorkspacePageQuery {
  /** Omit for legacy flat pages; null selects roots, an ID selects children. */
  readonly parentSessionId?: number | null;
  /** Opt-in append order for child pages. Requires sessionNestingOrder. */
  readonly childOrder?: 'nested';
  /** Explicit lifecycle window; omission preserves older callers, including closed-task history. */
  readonly state?: 'normal' | 'archived' | 'priority';
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
  readonly confirmedApps?: number;
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
  /** Normalized PNG data URL. Omit to preserve the image on update, or pass null to remove it. */
  readonly image?: string | null;
}
export const WORKSPACE_BRANCH_NAME_LIMIT = 240;
export const WORKSPACE_BRANCH_REF_LIMIT = WORKSPACE_BRANCH_NAME_LIMIT + 'refs/remotes/'.length;

export interface WorkspaceBranchQuery {
  readonly repoId: number;
  readonly query?: string;
  readonly limit?: number;
  /** Also return remote-tracking refs and unambiguous branch identities. */
  readonly includeRemote?: boolean;
}
export interface WorkspaceBranch {
  readonly name: string;
  readonly ref?: string;
  /** The local branch name that an existing-branch task would use. */
  readonly remoteBranch?: string;
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
  /** Opaque local HEAD/index/worktree version, independent of upstream activity. */
  readonly changesRevision?: string;
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
  readonly apps?: number;
  readonly unpushed: number;
  readonly uncommitted?: number;
}

export interface WorkspaceArchiveSession {
  readonly taskId: number;
  readonly sessionId: number;
  readonly confirmStop: boolean;
  /** Archive the session's nested conversations. Requires sessionArchiveChildren. */
  readonly includeChildren?: boolean;
  /** Explicitly approved currently running delegated children, verified again by the engine. */
  readonly stopAgents?: readonly number[];
}
export const WORKSPACE_ARCHIVE_AGENT_LIMIT = 32;
export interface WorkspaceDeleteSession {
  readonly taskId: number;
  readonly sessionId: number;
}
export interface WorkspaceRestoreSession {
  readonly taskId: number;
  readonly sessionId: number;
}

export interface WorkspaceMoveSession {
  readonly taskId: number;
  readonly sessionId: number;
  readonly parentSessionId: number | null;
}

/** Optional capability retains compatibility with engines using revision polling. */
export interface WorkspaceRevision {
  readonly revision: number;
  readonly version: 1;
  readonly revisionWait?: true;
  readonly chatStream?: true;
  readonly taskApps?: true;
  readonly appOpens?: readonly { readonly revision: number; readonly runId: string; readonly taskId: number; readonly sessionId: number }[];
  readonly sessionPriority?: true;
  readonly sessionNesting?: true;
  readonly sessionNestingOrder?: true;
  readonly sessionArchive?: true;
  readonly sessionArchiveChildren?: true;
  readonly sessionArchiveHistory?: true;
  readonly taskRequests?: true;
  readonly commitPanel?: true;
  readonly projectImages?: true;
}
export interface WorkspaceRevisionWait {
  readonly after: number;
  readonly requestId: string;
}
