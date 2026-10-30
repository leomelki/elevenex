/** Bounded, provider-neutral conversation contracts. Raw provider payloads stay in main/backend. */
export interface SessionChatTarget {
  readonly taskId: number;
  readonly sessionId: number;
}
export interface SessionChatRead extends SessionChatTarget {
  readonly requestId: string;
  readonly after?: string;
  readonly before?: string;
}
export interface SessionChatItem {
  readonly id: string;
  readonly kind:
    | "user"
    | "assistant"
    | "thinking"
    | "tool_use"
    | "tool_result"
    | "system"
    | "error";
  readonly text: string;
  readonly timestamp: string;
  readonly toolId: string | null;
  readonly toolName: string | null;
  readonly toolKind: string | null;
  readonly input: string;
  readonly error: boolean;
  readonly truncated: boolean;
}
export interface SessionChatQuestion {
  readonly id: string;
  readonly question: string;
  readonly multiple: boolean;
  readonly options: readonly {
    readonly label: string;
    readonly detail: string;
  }[];
}
/** Provider-reported subscription allowance; API-key sessions omit it. */
export interface SessionChatPlanUsage {
  readonly provider: "codex" | "claude";
  readonly planName: string | null;
  readonly status: "available" | "warning" | "exhausted";
  readonly windows: readonly {
    readonly id: string;
    readonly label: string;
    readonly remainingPercentage: number;
    /** Unix seconds, never a renderer-local countdown. */
    readonly resetsAt: number | null;
  }[];
  readonly updatedAt: string;
}
export interface SessionChatState {
  readonly provider: string;
  readonly providers?: readonly {
    readonly id: string;
    readonly label: string;
  }[];
  /** Omitted by older engines, which do not support harness selection. */
  readonly providerLocked?: boolean;
  /** Optional capabilities keep older engines usable without speculative controls. */
  readonly controls?: {
    readonly plan: boolean;
    readonly reasoning: boolean;
    readonly fast: boolean;
  };
  readonly fast?: boolean;
  readonly phase: "idle" | "running" | "waiting" | "error";
  readonly canInterrupt: boolean;
  readonly error: string | null;
  readonly model: string | null;
  readonly models: readonly {
    readonly id: string;
    readonly label: string;
    readonly reasoningEfforts?: readonly string[];
    readonly supportsFastMode?: boolean;
  }[];
  readonly reasoning: string | null;
  readonly plan: boolean;
  readonly permissionMode: string | null;
  readonly permissionModes: readonly string[];
  readonly context: {
    readonly tokens: number;
    readonly limit: number;
    readonly percentage: number;
  } | null;
  /** Optional for compatibility with engines predating subscription usage. */
  readonly planUsage?: SessionChatPlanUsage | null;
  readonly queue: readonly { readonly id: string; readonly text: string }[];
  readonly queuePaused: boolean;
  readonly permission: {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly input: string;
    readonly allowAlways: boolean;
  } | null;
  readonly question: {
    readonly id: string;
    readonly message: string;
    readonly questions: readonly SessionChatQuestion[];
    readonly url: string | null;
  } | null;
  readonly activity: readonly {
    readonly id: string;
    readonly label: string;
    readonly detail: string;
  }[];
}
export type SessionChatEvent =
  | { readonly type: "item"; readonly item: SessionChatItem }
  | { readonly type: "delta"; readonly id: string; readonly text: string }
  | { readonly type: "reset" };
export interface SessionChatPage extends SessionChatTarget {
  readonly cursor: string;
  /** A reset replaces the visible tail after reconnect, log expiry or transcript rewrite. */
  readonly reset: boolean;
  readonly items: readonly SessionChatItem[];
  readonly events: readonly SessionChatEvent[];
  readonly before: string | null;
  readonly state: SessionChatState;
}
export type SessionChatAction =
  | {
      readonly type: "provider";
      readonly provider: string;
      readonly expectedProvider: string;
    }
  | { readonly type: "send"; readonly text: string; readonly queue: boolean }
  | { readonly type: "stop" }
  | { readonly type: "cancel-queued" | "steer-queued"; readonly id: string }
  | { readonly type: "resume-queue" }
  | {
      readonly type: "permission";
      readonly id: string;
      readonly decision: "approved" | "always" | "denied";
    }
  | {
      readonly type: "answer";
      readonly id: string;
      readonly answers: Readonly<Record<string, readonly string[]>>;
      readonly decline?: boolean;
    }
  | { readonly type: "model"; readonly model: string | null }
  | { readonly type: "plan"; readonly enabled: boolean }
  | { readonly type: "reasoning"; readonly effort: string | null }
  | { readonly type: "fast"; readonly enabled: boolean }
  | { readonly type: "permission-mode"; readonly mode: string };
export interface SessionChatCommand extends SessionChatTarget {
  readonly action: SessionChatAction;
}
export interface SessionChatContentRead extends SessionChatTarget {
  readonly requestId: string;
  readonly itemId: string;
  readonly part: "text" | "input";
  readonly offset: number;
}
export interface SessionChatContent {
  readonly itemId: string;
  readonly part: "text" | "input";
  readonly offset: number;
  readonly text: string;
  readonly nextOffset: number | null;
  readonly total: number;
}
