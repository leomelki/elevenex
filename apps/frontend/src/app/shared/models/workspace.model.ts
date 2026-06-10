export interface Workspace {
  id: number;
  repoId: number;
  name: string;
  path: string;
  isDefault: boolean;
  createdFromRef: string | null;
  currentBranch: string | null;
  head: string | null;
  isDetached: boolean;
  isBare: boolean;
  isLocked: boolean;
  lockReason: string | null;
  isMissing: boolean;
  isDirty: boolean;
  hasConflicts?: boolean;
  linkStatus?: 'linked' | 'unlinked';
  desiredBranch?: string | null;
  unlinkedAt?: string | null;
  unlinkedByProjectId?: number | null;
  pendingStashCommit?: string | null;
  pendingStashMessage?: string | null;
  pendingStashCreatedAt?: string | null;
  pendingStashStatus?: 'pending' | 'applied' | 'apply_conflicted' | null;
  branchCheckedOutElsewhere: boolean;
  checkedOutElsewherePath: string | null;
}
