import type { BrowserElementReference, SessionAgentReturn, SessionAgentSender, SessionAgentTurnEntry, SessionChatToolCategory, SessionChatToolSource } from '@elevenex/shared';
import type { AgentWorkAction, AgentWorkBoard, AgentWorkCard, AgentWorkReply } from './agents/agent-work.models';
import type { ToolContentSource, ToolImage, ToolPresentation } from './tool-presentation';
import type { MarkdownEmbed } from './markdown/markdown-parser';

/** Renderer-owned view models. IDs are stable across streamed and incremental updates. */
export type ConversationStatus =
  | "running"
  | "attention"
  | "review"
  | "done"
  | "failed"
  | "queued";
export type ConversationMode = "plan" | "code";
export type PermissionLevel = "ask" | "edits" | "auto";
export type ThinkingLevel = "Off" | "Low" | "Medium" | "High" | "Max";
export interface AgentConfig {
  readonly id?: string;
  readonly preset?: string;
  /** The current chat's settings differ from the saved starting preset. */
  readonly presetEdited?: boolean;
  /** Saved default; also seeds the creator's local choice and carries its submission. */
  readonly default?: boolean;
  readonly mark: string;
  readonly harness: string;
  readonly model: string;
  readonly modelLabel?: string;
  readonly harnessLabel?: string;
  readonly thinking?: string;
  readonly fast?: boolean;
  readonly context?: number;
  /** Human-readable token usage supplied by the session owner. */
  readonly tokens?: string;
  /** Account plan limits, when the provider reports them. Fractions are remaining. */
  readonly plan?: AgentPlanUsage;
}
export interface AgentPlanUsage {
  readonly name?: string;
  readonly tier?: string;
  readonly win?: number;
  readonly week?: number;
  readonly resetWin?: string;
  readonly resetWeek?: string;
  /** Actual provider windows take precedence over the legacy two-window shorthand. */
  readonly windows?: readonly AgentPlanLimit[];
  readonly exhausted?: boolean;
  /** Model quota covers only the selected model; other models may still be usable. */
  readonly scope?: "account" | "model";
}
export interface AgentPlanLimit {
  readonly id: string;
  readonly label: string;
  readonly left: number;
  readonly reset?: string;
  readonly resetShort?: string;
  readonly weekly?: boolean;
}
export interface AgentModel {
  readonly id: string;
  readonly label: string;
  readonly thinking: readonly string[];
  readonly supportsFastMode?: boolean;
  /** Reported per-model quota; absent when the provider has not reported one. */
  readonly limit?: AgentPlanLimit;
}
export interface PermissionChoice {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}
export interface AgentHarness {
  readonly id: string;
  readonly label: string;
  readonly mark: string;
  readonly models: readonly AgentModel[];
}
export interface McpServer {
  readonly id: string;
  readonly name: string;
  readonly tools?: number;
  readonly on?: boolean;
  readonly error?: string;
}
export interface ConversationMention {
  readonly id: string;
  readonly kind: "session" | "task" | "file" | "element";
  readonly label: string;
  /** Element pin number; element mentions insert this pin instead of `@label`. */
  readonly marker?: number;
  readonly status?: ConversationStatus;
  readonly meta?: string;
}
export interface WaitingMessage extends QueuedMessage {
  readonly kind?: 'message' | 'action';
  readonly state: 'waiting' | 'sending';
}
export interface QueuedMessage {
  readonly steerable?: boolean;
  readonly editable?: boolean;
  readonly removable?: boolean;
  readonly id: string;
  /** Retain the mounted row when an optimistic message receives its durable ID. */
  readonly renderId?: string;
  readonly text: string;
}
export interface ConversationAttachment {
  /** Historical browser element snapshot carried by this image. */
  readonly element?: BrowserElementReference;
  /** The element's pin number within its message (1–8). */
  readonly marker?: number;
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly kind: "image" | "video" | "file";
  readonly size?: number;
  readonly preview?: string;
  readonly status?: "uploading" | "ready" | "error";
  readonly progress?: number;
  readonly error?: string;
}
/** Ephemeral renderer coordinates; never persisted or sent to the backend. */
export interface MessageSendOrigin {
  readonly left: number;
  readonly top: number;
  readonly at: number;
}
export interface ComposerSubmission {
  readonly sendOrigin?: MessageSendOrigin;
  readonly text: string;
  readonly intent: "send" | "queue" | "steer";
  readonly context: readonly ConversationMention[];
}
export interface RecordingState {
  readonly time: string;
  readonly interim: string;
}
export interface ChangedFile {
  readonly path: string;
  readonly add?: number;
  readonly del?: number;
  readonly status?: "M" | "A" | "D";
}
export type StepKind =
  | "think"
  | "read"
  | "search"
  | "list"
  | "edit"
  | "create"
  | "run"
  | "test"
  | "tool"
  | "media"
  | "web"
  | "ask"
  | "say"
  | "note";
export interface WorkStep {
  readonly id: string;
  readonly kind: StepKind;
  readonly detail?: string;
  readonly verb?: string;
  readonly status?: "running" | "done" | "failed" | "unknown";
  readonly meta?: string;
  readonly result?: string;
  readonly duration?: number;
  readonly diff?: { readonly add: number; readonly del: number };
  readonly output?: string;
  /** Parsed, bounded evidence. Original output stays separately inspectable. */
  readonly presentation?: ToolPresentation;
  readonly deferredTool?: SessionChatToolSource;
  /** Inline previews from this receipt, in transcript order. */
  readonly media?: readonly MarkdownEmbed[];
  /** Viewed images belong inside the tool disclosure. */
  readonly images?: readonly ToolImage[];
  /** Optional bounded-reader targets for input/output shortened by transport. */
  readonly fullContent?: ToolContentSource;
  readonly hunk?: readonly string[];
  readonly recovered?: boolean | string;
  readonly expected?: boolean | string;
  readonly text?: string;
  readonly title?: string;
  readonly progress?: number;
  readonly elapsed?: number;
  readonly agentEntry?: SessionAgentTurnEntry;
  readonly agentBoard?: AgentWorkBoard;
  readonly agentReply?: AgentWorkReply;
  readonly agentAction?: AgentWorkAction;
}
export interface WorkGroup {
  readonly id: string;
  readonly kind: "group";
  readonly label: string;
  readonly items: readonly WorkStep[];
}
export type TimelineEntry = WorkStep | WorkGroup;
export type TurnStatus = "live" | "done" | "stopped" | "failed";
export type TurnAction = "side-chat" | "fork" | "copy";
export interface TurnNavigationItem {
  readonly id: string;
  readonly label: string;
  readonly meta?: string;
  readonly state?: "changes" | "attention" | "live";
}
export interface QuestionOption {
  readonly label: string;
  readonly detail?: string;
  readonly recommended?: boolean;
}
export interface AgentQuestion {
  readonly id: string;
  readonly header?: string;
  readonly question: string;
  readonly kind?: "single" | "multi";
  readonly options: readonly QuestionOption[];
}
export type QuestionAnswers = Readonly<Record<string, readonly string[]>>;
export type ApprovalStatus = "pending" | "approved" | "always" | "denied";
export interface PlanStep {
  readonly id: string;
  readonly text: string;
  readonly state: "todo" | "running" | "done";
}
export interface SessionTask {
  readonly project?: string;
  readonly title: string;
  readonly branch?: string;
  readonly base?: string;
  readonly workspace?: {
    readonly state: "setup" | "ready";
    readonly step?: string;
  };
}
export interface DeferredTurnWork {
  readonly counts: Readonly<Partial<Record<SessionChatToolCategory, number>>>;
  readonly failures: number;
  readonly busy: boolean;
  readonly ready: boolean;
  readonly error?: 'failed' | 'changed' | 'too-large';
}
export type TurnWorkAction = 'retry' | 'refresh';
export interface TurnWorkToggle {
  readonly open: boolean;
  readonly toolIds: readonly string[];
}
export interface ChatHistoryRequest {
  readonly direction: "before" | "following";
  readonly source: "prefetch" | "reader";
}

export interface ChatExchange {
  /** Stable mounted identity across prompt receipt reconciliation; id stays canonical. */
  readonly renderId?: string;
  /** Whether this reply is currently receiving text, independently of tool work. */
  readonly streaming?: boolean;
  readonly isNew?: boolean;
  /** An explicit local send can reveal its turn even while reading above it. */
  readonly revealOnArrival?: boolean;
  readonly sendOrigin?: MessageSendOrigin;
  readonly overflow?: readonly {
    readonly id: string;
    readonly label: string;
  }[];
  readonly id: string;
  readonly prompt: string;
  readonly promptEditable?: boolean;
  readonly sender?: SessionAgentSender;
  readonly agentIndex?: readonly SessionAgentTurnEntry[];
  readonly agentCards?: readonly AgentWorkCard[];
  readonly replyIds?: readonly string[];
  readonly returnedTo?: readonly SessionAgentReturn[];
  readonly mentions?: readonly ConversationMention[];
  readonly attachments?: readonly ConversationAttachment[];
  readonly time?: string;
  readonly author?: string;
  /** Exact harness ID for the bundled logo; mark remains the fallback. */
  readonly harness?: string;
  readonly mark?: string;
  readonly status: TurnStatus;
  readonly steps: readonly WorkStep[];
  /** Saved counts are available before the activity is expanded. */
  readonly deferredWork?: DeferredTurnWork;
  /** Keep work after the latest reply in source order; omitted means all work precedes it. */
  readonly answerBeforeStepId?: string;
  /** Identity of the latest assistant message, retained when it becomes commentary. */
  readonly answerId?: string;
  readonly answer: string;
  /** Settled turn length in seconds, from the prompt to its last activity. */
  readonly duration?: number;
  readonly elapsed?: number;
  /** Epoch ms when the turn began; a live turn counts its own elapsed time from it. */
  readonly startedAt?: number;
  readonly files?: readonly ChangedFile[];
  readonly filesTotal?: number;
  readonly reviewAvailable?: boolean;
  readonly filesDiff?: { readonly add: number; readonly del: number };
  readonly sharedChanges?: boolean;
  readonly error?: string;
}
