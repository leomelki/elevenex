export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
  isDetached: boolean;
  isBare: boolean;
  isLocked: boolean;
  lockReason?: string;
}

export interface CreateWorktreeJob {
  jobId: string;
  repoId: number;
  branchName: string;
  worktreePath: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
}

export interface CreateWorktreeJobStatus {
  jobId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  branchName: string;
  worktreePath: string;
  result?: WorktreeInfo | null;
  error?: string | null;
}

export interface WorktreePoolOwner {
  projectId: number;
  projectName: string;
  repoId: number;
  workspaceId: number;
  workspaceName: string;
  linkStatus: 'linked' | 'unlinked';
}

export interface WorktreePoolProjectWorkspace {
  id: number;
  name: string;
  linkStatus: 'linked' | 'unlinked';
  desiredBranch: string | null;
  pendingStashCommit: string | null;
  pendingStashMessage: string | null;
  pendingStashCreatedAt: string | null;
  pendingStashStatus: 'pending' | 'applied' | 'apply_conflicted' | null;
}

export interface WorktreePoolItem {
  id: number;
  repoRootPath: string;
  path: string;
  name: string;
  createdFromRef: string | null;
  currentBranch: string | null;
  head: string | null;
  isDetached: boolean;
  isBare: boolean;
  isLocked: boolean;
  lockReason: string | null;
  isMissing: boolean;
  isDirty: boolean;
  hasConflicts: boolean;
  statusLoading: boolean;
  runningAgentCount: number;
  owner: WorktreePoolOwner | null;
  projectWorkspace: WorktreePoolProjectWorkspace | null;
}

export interface CreatePoolWorktreePayload {
  name: string;
  startPoint: string;
  branchName?: string;
  path?: string;
}

export interface LinkPoolWorktreePayload {
  workspaceName?: string;
  branchName: string;
  confirmTakeover?: boolean;
  confirmStash?: boolean;
  applyPendingStash?: boolean;
}
