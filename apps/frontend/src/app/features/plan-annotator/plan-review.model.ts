export type PlanReviewProvider = 'codex' | 'claude';

export type PlanReviewSource = 'transcript-plan' | 'exit-plan-permission';
export type PlanChatForkPoint = 'include_anchor' | 'before_anchor';

export interface PlanReviewRequest {
  provider: PlanReviewProvider;
  source: PlanReviewSource;
  sessionId: number;
  reviewId: string;
  planMarkdown: string;
  before?: string;
  after?: string;
  messageId?: string;
  anchorMessageId?: string;
  anchorMessageKind?: 'user' | 'assistant';
  pendingToolUseId?: string;
  pendingPermissionRequestId?: string;
  planChatForkPoint?: PlanChatForkPoint;
  requestId?: string;
  planFilePath?: string;
  createdAt: string;
  readonly?: boolean;
}

export type PlanCommentScope = 'selection' | 'document';

export interface PlanAnnotatorComment {
  id: string;
  scope: PlanCommentScope;
  quote: string;
  context: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanFeedbackPayload {
  review: PlanReviewRequest;
  message: string;
  comments: PlanAnnotatorComment[];
}
