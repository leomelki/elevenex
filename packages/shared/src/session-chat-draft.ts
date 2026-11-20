/** Device-local composer text. A null session ID identifies the task's new-session draft. */
export interface SessionChatDraftTarget {
  readonly taskId: number;
  readonly sessionId: number | null;
}

export interface SessionChatDraftText {
  readonly text: string;
  readonly checkDelivery?: true;
}

export interface SessionChatDraftSnapshot {
  readonly identity: string;
  readonly draft: SessionChatDraftText;
}

export interface SessionChatDraftEdit {
  readonly target: SessionChatDraftTarget;
  readonly draft: SessionChatDraftText;
  /** Move text to the confirmed session and remove its task's creation draft atomically. */
  readonly fromCreation?: true;
}
