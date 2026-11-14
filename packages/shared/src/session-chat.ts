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
/** Display metadata from a durable session-context snapshot; never includes its contents or path. */
export interface SessionChatMention {
  readonly sessionId: number;
  readonly title: string;
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
  /** Attachment references only; bytes are fetched separately for the selected chat. */
  readonly media?: readonly SessionChatMediaReference[];
  readonly mentions?: readonly SessionChatMention[];
  readonly text: string;
  readonly timestamp: string;
  readonly toolId: string | null;
  readonly toolName: string | null;
  readonly toolKind: string | null;
  readonly input: string;
  readonly error: boolean;
  readonly truncated: boolean;
  /** Provider-reported command facts; absent values remain unknown. */
  readonly execution?: {
    readonly exitCode?: number;
    readonly cwd?: string;
    readonly interrupted?: boolean;
  };
  /** Bounded outcome metadata; captured net changes take precedence over tool edits. */
  readonly changes?: SessionChatChangeSummary;
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
  /** Explicit send can resolve at most eight session identities into context. */
  readonly sessionMentions?: boolean;
  readonly attachments?: boolean;
  readonly browserElements?: boolean;
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
  /**
   * Legacy flat list kept for older desktops. Engines derive it from `work`;
   * renderers that understand `work` ignore it.
   */
  readonly activity: readonly {
    readonly id: string;
    readonly label: string;
    readonly detail: string;
  }[];
  /** Background work and noteworthy runtime events. Omitted by older engines. */
  readonly work?: SessionChatWork;
}
/** Live delegated agents and authoritative background tasks. */
export interface SessionChatBackgroundWork {
  /** Stable runtime key (`task:<id>` or `subagent:<id>`), also the stop target. */
  readonly id: string;
  readonly kind: "agent" | "task";
  /** Display label; includes the role so older desktops keep showing it. */
  readonly label: string;
  /** Primary task title, or the label without its role on older engines. */
  readonly title?: string;
  /** Agent nickname, displayed secondarily when a task title is available. */
  readonly agentName?: string;
  /** Harness agent type, such as `reviewer`. Omitted by older engines. */
  readonly role?: string;
  /** Latest summary, message or tool; empty when unreported. */
  readonly detail: string;
  /** ISO start time; null when unreported. */
  readonly startedAt: string | null;
  /** The harness can stop this item without interrupting the conversation. */
  readonly stoppable: boolean;
  /** Launched by work that already finished, so nothing waits for its result. */
  readonly orphaned: boolean;
  readonly tokens?: number;
  readonly toolUses?: number;
  readonly status?: SessionChatWorkStatus;
  /** False for foreground delegated agents. Omitted by older engines. */
  readonly background?: boolean;
  readonly agentId?: string;
  readonly inspectable?: boolean;
  readonly canBackground?: boolean;
  readonly model?: string;
  readonly context?: SessionChatAgentContext;
}
export type SessionChatWorkStatus = "pending" | "running" | "waiting" | "paused" | "completed" | "interrupted" | "stopped" | "error" | "closed" | "unavailable";
export interface SessionChatAgentContext {
  readonly tokens: number;
  readonly limit: number;
  readonly percentage: number;
}
export interface SessionChatAgentRead extends SessionChatTarget {
  readonly requestId: string;
  readonly agentId: string;
  readonly before?: string;
}
export interface SessionChatAgentPage {
  readonly agentId: string;
  readonly label: string;
  readonly title?: string;
  readonly agentName?: string;
  readonly role?: string;
  readonly status: SessionChatWorkStatus;
  readonly prompt: string;
  readonly model: string | null;
  readonly context: SessionChatAgentContext | null;
  readonly items: readonly SessionChatItem[];
  readonly before: string | null;
  readonly availability: "available" | "starting" | "unavailable" | "error";
  readonly message: string;
}
/** A bounded, already-filtered runtime event worth a person's attention. */
export interface SessionChatWorkEvent {
  readonly id: string;
  readonly kind:
    | "finished"
    | "hook"
    | "retry"
    | "compaction"
    | "notification"
    | "transcript"
    | "plugin";
  readonly tone: "info" | "success" | "warning" | "danger";
  readonly title: string;
  readonly detail: string;
  /** ISO time; null when unreported. */
  readonly at: string | null;
  readonly agentId?: string;
}
export interface SessionChatWork {
  /** At most 16 live items; waiting work first, then oldest first. */
  readonly running: readonly SessionChatBackgroundWork[];
  /** At most 12 events, newest first. Routine successes are never included. */
  readonly recent: readonly SessionChatWorkEvent[];
  readonly totalRunning?: number;
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
  | { readonly type: "send"; readonly text: string; readonly queue: boolean; readonly sessionIds?: readonly number[] }
  | { readonly type: "stop" }
  /** Ends one `work.running` item; the conversation and its turn continue. */
  | { readonly type: "stop-background"; readonly id: string }
  | { readonly type: "background-agent"; readonly id: string }
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

export interface SessionChatChangedFile {
  readonly path: string;
  readonly status: "A" | "M" | "D";
  readonly add: number;
  readonly del: number;
}
export interface SessionChatChangeSummary {
  readonly files: readonly SessionChatChangedFile[];
  readonly total: number;
}
export interface SessionChatChangesRead extends SessionChatTarget {
  readonly requestId: string;
  readonly turnId: string;
  readonly offset: number;
  readonly path?: string;
  readonly lineOffset?: number;
  readonly revision?: string;
}
export interface SessionChatChangeLine {
  readonly id: string;
  readonly kind: "context" | "add" | "del";
  readonly oldNumber?: number;
  readonly newNumber?: number;
  readonly text: string;
}
export interface SessionChatChangesPage {
  readonly turnId: string;
  readonly revision: string;
  readonly offset: number;
  readonly files: readonly SessionChatChangedFile[];
  readonly total: number;
  readonly nextOffset: number | null;
  readonly content: {
    readonly path: string;
    readonly lines: readonly SessionChatChangeLine[];
    readonly nextOffset: number | null;
    readonly error?: string;
  } | null;
}

export interface SessionChatMediaReference {
  readonly kind?: "image" | "video" | "file";
  readonly id: string;
  readonly path: string;
  readonly caption: string;
  readonly inline: boolean;
}
export interface SessionChatMediaRead extends SessionChatTarget {
  readonly requestId: string;
  readonly itemId: string;
  readonly mediaId: string;
}
export interface SessionChatMedia {
  readonly itemId: string;
  readonly mediaId: string;
  readonly source: string;
}
