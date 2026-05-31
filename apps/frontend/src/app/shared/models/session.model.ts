export interface Session {
  id: number;
  repoId: number;
  projectId: number;
  workspaceId?: number | null;
  branchName: string;
  worktreePath: string;
  name: string | null;
  surface?: 'session' | 'embedded_plan_chat' | string;
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
  workspaceId?: number | null;
  branchName: string;
  name: string | null;
  status: 'created' | 'active' | 'archived' | 'stopped';
  hasUnreviewedCompletion: boolean;
  lastCompletionAt: string | null;
  lastCompletionKind: 'completed' | null;
  lastStateChangeAt: string | null;
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
  anchorMessageId: string;
  anchorMessageKind: 'user' | 'assistant';
  pendingToolUseId?: string;
  pendingPermissionRequestId?: string;
  planChatForkPoint?: 'include_anchor' | 'before_anchor';
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
