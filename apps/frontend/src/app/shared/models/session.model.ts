export interface Session {
  id: number;
  repoId: number;
  projectId: number;
  branchName: string;
  worktreePath: string;
  name: string | null;
  status: 'created' | 'active' | 'archived' | 'stopped';
  claudeSessionId: string;
  hasInjectedWorktreeContext: boolean;
  hasUnreviewedCompletion: boolean;
  lastCompletionAt: string | null;
  lastCompletionKind: 'completed' | null;
  lastStateChangeAt: string | null;
  createdAt: string;
  updatedAt: string;
  repoColor?: string | null; // Populated when session is loaded with repo context
}

// Session data from navigation tree (may have different fields)
export interface SessionInTree {
  id: number;
  repoId: number;
  branchName: string;
  name: string | null;
  status: 'created' | 'active' | 'archived' | 'stopped';
  hasUnreviewedCompletion: boolean;
  lastCompletionAt: string | null;
  lastCompletionKind: 'completed' | null;
  lastStateChangeAt: string | null;
}
