import { EventEmitter } from 'events';

/** Provider and reasoning IDs are extensible strings; catalogs advertise known values. */
export type AgentProviderId = string;
export type AgentPermissionMode = string;
export type AgentReasoningEffort = string;
export type AgentImageMediaType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp';

export interface AgentRuntimeProviderCapabilities {
  mcp: boolean;
  subagents: boolean;
  permissions: boolean;
  userInput: boolean;
  multimodalPrompts: boolean;
  terminalFallback: boolean;
  rewindConversation: boolean;
  /** Automatic text input can join a live turn without interrupting its work. */
  nonInterruptingSteering?: boolean;
}

export interface AgentRuntimeProviderInfo {
  id: AgentProviderId;
  displayName: string;
  capabilities: AgentRuntimeProviderCapabilities;
  /** Selectable permission modes advertised by this provider, when supported. */
  permissionModes?: readonly string[];
}

/** Known progression for unordered catalogs, never a fallback capability list. */
export const AGENT_REASONING_EFFORTS = [
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;

export type AgentCatalogModel =
  import('../claude-runtime/claude-runtime.types.js').ClaudeModelOption;

/**
 * Session-independent view of what a provider can be pinned to, used by the
 * default-model/thinking-level pickers in settings. Providers report this
 * themselves so a newly released model shows up without any UI change.
 */
export interface AgentProviderModelCatalogPayload {
  models: AgentCatalogModel[];
  /** Provider-wide levels; a model may narrow these via `reasoningEfforts`. */
  reasoningEfforts: string[];
  /** What the provider falls back to when nothing is pinned, if known. */
  providerDefaultModelId: string | null;
  providerDefaultReasoningEffort?: string | null;
  /** False when a model cannot be chosen ahead of a session. */
  supportsModelSelection: boolean;
  /** Set when the list is empty for a knowable reason (e.g. signed out). */
  unavailableReason?: string | null;
}

export interface AgentProviderModelCatalog extends AgentProviderModelCatalogPayload {
  provider: AgentProviderId;
  displayName: string;
}

export interface AgentRunLifecycle {
  sessionState?: string | null;
  runPhase?: string | null;
  backgroundWork?: readonly unknown[] | null;
  pendingPrompts?: readonly unknown[] | null;
  dispatchingPrompts?: readonly unknown[] | null;
  queuePaused?: boolean | null;
  /** Provider task history, used to describe live work. */
  tasks?: readonly unknown[] | null;
}

export interface AgentRuntimeStatePayload extends AgentRunLifecycle {
  sessionId: number;
  planMode?: boolean | null;
  reasoningEffort?: AgentReasoningEffort | null;
  fastMode?: boolean;
}

export interface AgentSessionSnapshotPayload extends AgentRuntimeStatePayload {
  history: AgentTranscriptItem[];
}

export type AgentTranscriptItem =
  import('../claude-runtime/claude-runtime.types.js').ClaudeTranscriptItem;

export interface AgentAutocompleteItem {
  id: string;
  kind: string;
  trigger: string;
  label: string;
  insertText: string;
  description: string;
  detail?: string;
  source?: string;
}

export interface AgentRuntimeEvent {
  type: string;
  payload: {
    sessionId: number;
  };
}

export interface AgentSubagentHistoryPayload {
  subagent?: import('../claude-runtime/claude-runtime.types.js').ClaudeSubagentState;
  transcriptState?: 'starting' | 'available' | 'unavailable' | 'error';
  hasEarlier?: boolean;
  nativeWindow?: true;
  transcriptError?: string;
  history: AgentTranscriptItem[];
  transcriptAvailable: boolean;
}

export type AgentMcpSnapshot = import('../mcp/mcp.types.js').McpSnapshot;
export type AgentMcpAuthStartResult =
  import('../mcp/mcp.types.js').McpAuthStartResult;

export interface AgentAuthStatus {
  isAuthenticating: boolean;
  output: string[];
  error?: string;
  [key: string]: unknown;
}

/**
 * Provider-reported subscription allowance. This deliberately models a
 * percentage and reset time instead of message counts: both Codex and Claude
 * meter task complexity, so a message-count estimate would be misleading.
 */
export interface AgentPlanUsageWindow {
  id: string;
  label: string;
  remainingPercentage: number;
  resetsAt: number | null;
}

export interface AgentPlanUsage {
  provider: 'claude' | 'codex';
  planName: string | null;
  status: 'available' | 'warning' | 'exhausted';
  windows: AgentPlanUsageWindow[];
  credits: {
    balance: string | null;
    unlimited: boolean;
  } | null;
  updatedAt: string;
}

export interface AgentImageInput {
  mediaType: AgentImageMediaType;
  data: string;
}

export type NativeAppLaunchPolicy = 'launch' | 'request' | 'plan';
export type AgentPromptDisposition = 'running' | 'queued' | 'steered';

export interface AgentPromptOptions {
  human?: boolean;
  origin?: InteractivePromptOrigin;
  queue?: boolean;
  /** Prefer same-turn delivery for a text follow-up, when the harness can do so. */
  preferSteering?: boolean;
  /** Reject before dispatch if no active turn can accept live input. */
  requireSteering?: boolean;
  /** Pass false to return once the harness owns this specific prompt. */
  waitForCompletion?: boolean;
  onAccepted?: (disposition: AgentPromptDisposition) => void;
}

/** Set by desktop chat handlers, never copied from prompt request bodies. */
export type InteractivePromptOrigin = 'desktop-chat';

export interface AgentRuntimeProviderBase extends EventEmitter {
  readonly info: AgentRuntimeProviderInfo;

  getHistory(sessionId: number, options?: { changeDetails?: 'summary' }): Promise<AgentTranscriptItem[]>;
  /** initialize=false permits pre-start selection without creating a native conversation. */
  getRuntimeState(
    sessionId: number,
    options?: { initialize?: boolean },
  ): Promise<AgentRuntimeStatePayload>;
  /** In-memory authority of the running turn. Reading this must not start a provider. */
  nativeAppLaunchPolicy?(sessionId: number): NativeAppLaunchPolicy;
  getSnapshot(sessionId: number): Promise<AgentSessionSnapshotPayload>;
  getAutocompleteItems(sessionId: number): Promise<AgentAutocompleteItem[]>;
  setSelectedModel(
    sessionId: number,
    model: string | null,
  ): Promise<AgentRuntimeStatePayload>;

  submitPrompt(
    sessionId: number,
    prompt: string,
    titlePrompt?: string,
    images?: AgentImageInput[],
    options?: AgentPromptOptions,
  ): Promise<void>;
  interrupt(sessionId: number): Promise<void>;
  cancelPendingPrompt(sessionId: number, id: string): Promise<void>;
  steerPendingPrompt(sessionId: number, id: string, origin?: InteractivePromptOrigin): Promise<void>;
  resumePendingPrompts(sessionId: number, origin?: InteractivePromptOrigin): Promise<void>;
  clearPendingPrompts(sessionId: number): Promise<void>;
  cleanupSession(sessionId: number): Promise<void>;
  reactivateSession?(sessionId: number): Promise<void> | void;
}

export type AgentLoginMode = 'oauth' | 'api_key';

export interface AgentLoginStartResult {
  mode: AgentLoginMode;
  authUrl: string | null;
  userCode: string | null;
  message: string;
  supportsManualCode?: boolean;
}

export interface AgentRuntimeProviderFeatures {
  setAgentAutonomy(
    sessionId: number,
    mode: import('../sessions/sessions.service.js').AgentAutonomyMode,
  ): Promise<AgentRuntimeStatePayload>;
  /**
   * Selectable models and thinking levels, independent of any session. Should
   * use a bounded cache. An explicit refresh waits for the current CLI to
   * report its models, bypassing that cache without interrupting active turns.
   */
  getModelCatalog(refresh?: boolean): Promise<AgentProviderModelCatalogPayload>;
  getAuthStatus(): Promise<AgentAuthStatus>;
  startLogin(options: {
    mode: AgentLoginMode;
    apiKey?: string;
    oauthProvider?: string;
    apiKeyProvider?: string;
  }): Promise<AgentLoginStartResult>;
  cancelLogin(): Promise<AgentAuthStatus>;
  continueLogin(options: { code: string }): Promise<AgentAuthStatus>;
  stopBackgroundTask(sessionId: number, taskId: string): Promise<void>;
  stopSubagent(sessionId: number, agentId: string): Promise<void>;
  backgroundSubagent(sessionId: number, agentId: string): Promise<void>;
  getSubagentHistory(
    sessionId: number,
    agentId: string,
    options?: { before?: string; through?: string },
  ): Promise<AgentSubagentHistoryPayload>;
  reloadMcpConfiguration(sessionId: number): Promise<void>;
  getMcpSnapshot(
    sessionId: number,
    forceRefresh?: boolean,
  ): Promise<AgentMcpSnapshot>;
  recheckMcpServer(
    sessionId: number,
    serverName: string,
    scope?: import('../mcp/mcp.types.js').McpScope,
  ): Promise<AgentMcpSnapshot>;
  startMcpAuth(
    sessionId: number,
    serverName: string,
    scope?: import('../mcp/mcp.types.js').McpScope,
  ): Promise<AgentMcpAuthStartResult>;
  setPermissionMode(
    sessionId: number,
    mode: AgentPermissionMode | null,
    origin?: InteractivePromptOrigin,
  ): Promise<AgentRuntimeStatePayload>;
  setPlanMode(
    sessionId: number,
    enabled: boolean,
  ): Promise<AgentRuntimeStatePayload>;
  setReasoningEffort(
    sessionId: number,
    effort: AgentReasoningEffort | null,
  ): Promise<AgentRuntimeStatePayload>;
  setFastMode(
    sessionId: number,
    enabled: boolean,
  ): Promise<AgentRuntimeStatePayload>;

  openTerminalFallback(sessionId: number): Promise<unknown>;
  forkConversation(
    request: AgentForkConversationRequest,
  ): Promise<AgentForkConversationResult>;
  rewindConversation(
    sessionId: number,
    messageId: string,
    origin?: InteractivePromptOrigin,
  ): Promise<AgentTranscriptItem[]>;
  approvePermission(
    sessionId: number,
    requestId: string,
    remember?: boolean,
    content?: Record<string, unknown>,
  ): Promise<void>;
  denyPermission(
    sessionId: number,
    requestId: string,
    message?: string,
  ): Promise<void>;
  answerUserInput(
    sessionId: number,
    requestId: string,
    action?: 'accept' | 'decline' | 'cancel',
    content?: Record<string, string | number | boolean | string[]>,
  ): Promise<void>;
  onClientAttached(sessionId: number): void;
  onClientDetached(sessionId: number): void;
}

export type AgentRuntimeProvider = AgentRuntimeProviderBase &
  Partial<AgentRuntimeProviderFeatures>;

export interface AgentRuntimeCleanup {
  cleanupSession(sessionId: number): Promise<void>;
  reactivateSession?(sessionId: number): Promise<void>;
}

export interface AgentForkConversationRequest {
  parentSessionId: number;
  childSessionId: number;
  anchorMessageId?: string;
  anchorMessageKind?: 'user' | 'assistant';
  anchorToolUseId?: string;
  activePermissionRequestId?: string;
  childSessionName: string;
}

export interface AgentForkConversationResult {
  providerSessionId: string | null;
  draft?: string | null;
  anchorExcerpt?: string | null;
}
