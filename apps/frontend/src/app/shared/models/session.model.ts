export interface Session {
  id: number;
  repoId: number;
  projectId: number;
  workspaceId: number | null;
  branchName: string;
  worktreePath: string;
  name: string | null;
  workspaceName?: string | null;
  status: 'created' | 'active' | 'archived' | 'stopped';
  activeAgentProvider: string;
  claudeSessionId: string;
  codexSessionId: string;
  piSessionPath?: string;
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
  workspaceId: number | null;
  branchName: string;
  name: string | null;
  status: 'created' | 'active' | 'archived' | 'stopped';
  hasUnreviewedCompletion: boolean;
  lastCompletionAt: string | null;
  lastCompletionKind: 'completed' | null;
  lastStateChangeAt: string | null;
}
