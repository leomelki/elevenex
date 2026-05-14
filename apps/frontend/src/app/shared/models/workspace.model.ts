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
  branchCheckedOutElsewhere: boolean;
  checkedOutElsewherePath: string | null;
}
