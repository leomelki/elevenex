export interface BranchInfo {
  name: string;
  commit: string;
  label: string;
  current: boolean;
  isRemote: boolean;
  hasWorktree: boolean;
  worktreePath: string | null;
}