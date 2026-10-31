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
  /** Bounded saved starting configurations; omitted by older engines. */
  readonly presets?: readonly SessionChatPreset[];
  readonly presetCatalogs?: boolean;
  readonly presetDefault?: SessionChatPresetDefault;
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
export interface SessionChatPresetDefault {
  readonly id: string | null;
  readonly provider: string;
  /** Provider-level defaults are retained so Undo can restore them exactly. */
  readonly defaultIds: readonly string[];
  readonly revision: string;
}
export interface SessionChatCommandReply {
  readonly accepted: true;
  readonly defaultChange?: {
    readonly before: SessionChatPresetDefault;
    readonly after: SessionChatPresetDefault;
  };
}
export type SessionChatAction =
  | {
      readonly type: "preset-default";
      readonly id: string;
      readonly expectedProvider: string;
      readonly expectedRevision: string;
    }
  | {
      readonly type: "preset-default-restore";
      readonly provider: string;
      readonly defaultIds: readonly string[];
      readonly expectedRevision: string;
    }
  | {
      readonly type: "preset";
      readonly id: string;
      readonly expectedProvider: string;
    }
  | {
      readonly type: "save-preset";
      /** Optional for compatibility: omitted means the current conversation harness. */
      readonly provider?: string;
      readonly makeDefault?: boolean;
      readonly expectedDefaultRevision?: string;
      readonly id: string;
      readonly name: string;
      readonly expectedProvider: string;
      readonly model: string | null;
      readonly reasoning: string | null;
      readonly fast: boolean;
    }
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

export interface SessionChatPreset {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly providerLabel: string;
  readonly model: string | null;
  readonly modelLabel: string;
  readonly reasoning: string | null;
  readonly fast: boolean;
}

export interface SessionChatCatalogRead extends SessionChatTarget {
  readonly refresh?: boolean;
  readonly provider: string;
  readonly requestId: string;
}
/** A bounded, session-independent catalog; this read never switches or starts a harness. */
export interface SessionChatCatalog {
  readonly provider: string;
  readonly label: string;
  readonly models: SessionChatState["models"];
  readonly model: string | null;
  readonly reasoning: string | null;
  readonly fast: boolean;
  readonly reasoningAvailable: boolean;
  readonly fastAvailable: boolean;
  readonly error: string | null;
}
