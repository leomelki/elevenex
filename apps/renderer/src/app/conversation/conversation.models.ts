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
  readonly preset?: string;
  readonly mark: string;
  readonly harness: string;
  readonly model: string;
  readonly thinking?: ThinkingLevel;
  readonly fast?: boolean;
  readonly context?: number;
}
export interface AgentModel {
  readonly id: string;
  readonly label: string;
  readonly thinking: readonly ThinkingLevel[];
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
  readonly kind: "session" | "task" | "file";
  readonly label: string;
  readonly status?: ConversationStatus;
  readonly meta?: string;
}
export interface QueuedMessage {
  readonly id: string;
  readonly text: string;
}
export interface ComposerSubmission {
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
  | "web"
  | "ask"
  | "say"
  | "note";
export interface WorkStep {
  readonly id: string;
  readonly kind: StepKind;
  readonly detail?: string;
  readonly verb?: string;
  readonly status?: "running" | "done" | "failed";
  readonly meta?: string;
  readonly result?: string;
  readonly duration?: number;
  readonly diff?: { readonly add: number; readonly del: number };
  readonly output?: string;
  readonly hunk?: readonly string[];
  readonly recovered?: boolean | string;
  readonly expected?: boolean | string;
  readonly text?: string;
  readonly title?: string;
  readonly progress?: number;
  readonly elapsed?: number;
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
export interface ChatExchange {
  readonly isNew?: boolean;
  readonly overflow?: readonly { readonly id: string; readonly label: string }[];
  readonly id: string;
  readonly prompt: string;
  readonly time?: string;
  readonly author?: string;
  readonly mark?: string;
  readonly status: TurnStatus;
  readonly steps: readonly WorkStep[];
  readonly answer: string;
  readonly duration?: number;
  readonly elapsed?: number;
  readonly files?: readonly ChangedFile[];
  readonly error?: string;
}
