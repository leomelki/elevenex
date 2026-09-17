export interface Session {
  id: number;
  repoId: number;
  projectId: number;
  workspaceId?: number | null;
  folderId?: number | null;
  branchName: string;
  worktreePath: string;
  name: string | null;
  surface?: 'session' | 'embedded_plan_chat' | string;
  isTemporary?: boolean;
  workspaceName?: string | null;
  status: 'created' | 'active' | 'archived' | 'stopped';
  archivedByFolder?: boolean;
  activeAgentProvider: string;
  claudeSessionId: string;
  codexSessionId: string;
  piSessionPath?: string;
  antigravitySessionId?: string;
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
  workspaceId?: number | null;
  folderId?: number | null;
  isTemporary?: boolean;
  branchName: string;
  name: string | null;
  status: 'created' | 'active' | 'archived' | 'stopped';
  archivedByFolder?: boolean;
  hasUnreviewedCompletion: boolean;
  lastCompletionAt: string | null;
  lastCompletionKind: 'completed' | null;
  lastStateChangeAt: string | null;
}

export interface SessionFolder {
  id: number;
  repoId: number;
  workspaceId: number;
  name: string;
  archivedAt: string | null;
  sessions: SessionInTree[];
  archivedSessions: SessionInTree[];
  createdAt?: string;
  updatedAt?: string;
}

export interface SessionFork {
  id: number;
  parentSessionId: number;
  childSessionId: number;
  provider: string;
  anchorMessageId: string;
  anchorMessageKind: 'user' | 'assistant';
  anchorExcerpt: string | null;
  draft: string | null;
  createdAt: string;
  childSession: Session | null;
}

export interface CreateSessionForkRequest {
  anchorMessageId: string;
  anchorMessageKind: 'user' | 'assistant';
  anchorExcerpt?: string;
  name?: string;
}

export interface CreateSessionForkResponse {
  fork: SessionFork;
  session: Session;
  draft: string | null;
}

export interface PlanChatFork {
  id: number;
  parentSessionId: number;
  childSessionId: number;
  provider: string;
  reviewId: string;
  anchorMessageId: string;
  anchorMessageKind: 'user' | 'assistant';
  anchorExcerpt: string | null;
  planExcerpt: string | null;
  createdAt: string;
  updatedAt: string;
  childSession: Session | null;
}

export interface EnsurePlanChatRequest {
  reviewId: string;
  reviewSource?: 'transcript-plan' | 'exit-plan-permission';
  anchorMessageId?: string;
  anchorMessageKind?: 'user' | 'assistant';
  permissionRequestId?: string;
  toolUseId?: string;
  planMarkdown?: string;
  name?: string;
}

export interface EnsurePlanChatResponse {
  planChat: PlanChatFork;
  session: Session;
}

export interface SubmitPlanChatQuestionRequest {
  question: string;
}

export interface SubmitPlanChatQuestionResponse {
  planChat: PlanChatFork;
  session: Session;
  question: string;
}
