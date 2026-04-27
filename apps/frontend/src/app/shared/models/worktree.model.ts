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
