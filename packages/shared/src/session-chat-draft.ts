/** Device-local composer text. A null session ID identifies the task's new-session draft. */
export interface SessionChatDraftTarget {
  readonly taskId: number;
  readonly sessionId: number | null;
}

export const SESSION_CHAT_RETAINED_SEND_LIMIT = 8;

export interface SessionChatRetainedSend {
  /** Null for pre-receipt drafts whose outcome can no longer be correlated. */
  readonly id: string | null;
  readonly text: string;
  readonly rejected?: true;
}

export interface SessionChatDraftText {
  readonly text: string;
  readonly checkDelivery?: true;
  readonly pending?: { readonly id: string; readonly text: string };
  readonly retained?: readonly SessionChatRetainedSend[];
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
