export type TaskMode = 'new' | 'existing';
export type TaskCheckoutMode = 'branch' | 'snapshot';
export type TaskState =
  | 'preparing'
  | 'ready'
  | 'failed'
  | 'finishing'
  | 'releasing'
  | 'released';

export interface TaskSetup {
  requestId: string;
  name?: string;
  branchName: string;
  mode: TaskMode;
  baseRef?: string;
  checkoutMode?: TaskCheckoutMode;
  environment?: 'automatic' | 'new' | 'existing';
  worktreeId?: number;
  confirmOverLimit?: boolean;
  confirmExternal?: boolean;
  useSavedRef?: boolean;
  // Recorded before filesystem changes so retries use the same resolved revision.
  resolvedCommit?: string;
  // New branches summarize changes since creation, also after reopening.
  contextRootRef?: string;
  branchPrepared?: boolean;
  localBranch?: string;
  preparationStage?:
    | 'refreshing_ref'
    | 'preparing_checkout'
    | 'restoring_sessions';
}
