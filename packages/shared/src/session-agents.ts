/** Bounded display data shared by the conversation and workspace navigation. */
export interface SessionAgentSelection {
  readonly provider: string;
  readonly model?: string;
  readonly effort?: string;
}

export interface SessionAgentReference {
  readonly sessionId: number;
  readonly taskId?: number;
  readonly title?: string;
  readonly selection?: SessionAgentSelection;
}

export interface SessionAgentSender {
  readonly session: SessionAgentReference;
  readonly purpose: 'assignment' | 'message';
  readonly messageId?: string;
}

export type SessionAgentStatus = 'pending' | 'running' | 'waiting' | 'paused' |
  'completed' | 'stopped' | 'error' | 'unavailable';

export interface DelegatedSessionWork {
  readonly session: SessionAgentReference;
  readonly status: SessionAgentStatus;
  readonly detail: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly toolUses?: number;
  readonly tokens?: number;
  readonly delivered?: readonly string[];
}

export interface SessionAgentReturn {
  readonly itemId: string;
  readonly recipient: SessionAgentReference;
  readonly at: string;
}

export interface SessionAgentContext {
  readonly parent?: SessionAgentReference;
  readonly selection?: SessionAgentSelection;
  readonly parentWaiting?: true;
  readonly returns?: readonly SessionAgentReturn[];
}

export interface SessionAgentOperation {
  readonly type: 'launch' | 'message' | 'wait' | 'stop' | 'read' | 'search' | 'catalog' | 'native' | 'native-wait';
  readonly sessions?: readonly number[];
  readonly agents?: readonly string[];
  readonly title?: string;
  readonly identity?: SessionAgentSelection;
  readonly requestId?: string;
  readonly message?: string;
}

export interface SessionAgentOperationResult {
  readonly session?: SessionAgentReference;
  readonly agentId?: string;
  readonly status?: SessionAgentStatus;
  readonly delivery?: 'queued' | 'accepted' | 'unconfirmed';
  readonly messageId?: string;
  readonly event?: string;
  readonly detail?: string;
  readonly agents?: readonly { readonly agentId: string; readonly status: SessionAgentStatus; readonly detail?: string }[];
  readonly reply?: {
    readonly id: string;
    readonly text: string;
    readonly truncated: boolean;
    readonly changes?: import('./session-chat').SessionChatChangeSummary;
  };
}

export interface SessionAgentTurnEntry {
  readonly id: string;
  readonly toolId?: string;
  readonly at: string;
  readonly endedAt?: string;
  readonly operation: SessionAgentOperation;
  readonly result?: SessionAgentOperationResult;
  readonly failed?: true;
}

export type SessionChildSummary = {
  readonly status: 'attention' | 'failed' | 'running' | 'done';
  readonly count: number;
};
