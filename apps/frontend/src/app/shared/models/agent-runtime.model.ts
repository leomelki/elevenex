export type AgentProviderId = 'claude' | 'codex' | 'pi' | 'antigravity' | 'opencode' | string;

export interface AgentRuntimeProviderCapabilities {
  mcp: boolean;
  subagents: boolean;
  permissions: boolean;
  userInput: boolean;
  multimodalPrompts: boolean;
  terminalFallback: boolean;
  rewindConversation: boolean;
}

export interface AgentRuntimeProviderInfo {
  id: AgentProviderId;
  displayName: string;
  capabilities: AgentRuntimeProviderCapabilities;
}

export type AgentLoginMode = 'oauth' | 'api_key';

export interface AgentLoginStartResult {
  mode: AgentLoginMode;
  authUrl: string | null;
  userCode: string | null;
  message: string;
  supportsManualCode?: boolean;
}

export interface AgentAuthStatus {
  isAuthenticating: boolean;
  output: string[];
  error?: string;
  installed?: boolean;
  version?: string | null;
  authenticated?: boolean;
  authMethod?: 'oauth' | 'api_key' | 'vertex' | 'gateway' | 'none' | 'unknown';
  email?: string;
  authPath?: string;
  loginMode?: AgentLoginMode | null;
  loginUrl?: string | null;
  loginUserCode?: string | null;
  loginError?: string | null;
  /** Shown when the provider's CLI is missing, e.g. an install command. */
  installHint?: string | null;
}

/** Provider-reported allowance for a quota-backed Codex or Claude plan. */
export interface AgentPlanUsageWindow {
  id: string;
  label: string;
  remainingPercentage: number;
  /** Unix timestamp in seconds, matching both provider protocols. */
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

export type AgentImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface AgentImageInput {
  mediaType: AgentImageMediaType;
  data: string;
}

export type AgentRuntimeCommand =
  | { type: 'hydrate'; includeHistory?: boolean }
  | { type: 'interrupt' | 'resume_pending_prompts' | 'clear_pending_prompts' }
  | { type: 'submit_prompt'; prompt: string; titlePrompt?: string; images?: AgentImageInput[] }
  | { type: 'cancel_pending_prompt' | 'steer_pending_prompt'; id: string }
  | {
      type: 'approve_permission';
      requestId: string;
      remember?: boolean;
      content?: Record<string, unknown>;
    }
  | { type: 'deny_permission'; requestId: string; message?: string }
  | {
      type: 'answer_user_input';
      requestId: string;
      action: 'accept' | 'decline' | 'cancel';
      content?: Record<string, unknown>;
    };

export type AgentRunPhase = 'idle' | 'running' | 'waiting' | 'error';
export type AgentStatusBarPhase =
  | 'ready'
  | 'initializing'
  | 'idle'
  | 'running'
  | 'waiting'
  | 'error';
export type AgentSessionExecutionState = 'idle' | 'running' | 'requires_action' | null;
export type AgentRuntimeWarmState = 'cold' | 'prewarming' | 'warm' | 'closing';
export type AgentPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto'
  | string;
export type AgentFastModeState = 'off' | 'cooldown' | 'on';
export type AgentReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | string;

export type AgentTranscriptItemKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'system'
  | 'error';

export type AgentToolKind =
  | 'read'
  | 'write'
  | 'edit'
  | 'notebook_edit'
  | 'bash'
  | 'grep'
  | 'glob'
  | 'web_fetch'
  | 'web_search'
  | 'file_changes'
  | 'task_agent'
  | 'todo_write'
  | 'ask_user_question'
  | 'enter_plan_mode'
  | 'exit_plan_mode'
  | 'worktree'
  | 'lsp'
  | 'skill'
  | 'mcp'
  | 'unknown';

export type AgentToolInteractionKind =
  | 'permission'
  | 'ask_user_question'
  | 'plan_mode'
  | 'exit_plan_mode';

export type AgentToolInteractionTone = 'ok' | 'warn' | 'neutral';

export interface AgentToolInteractionAnswer {
  question: string;
  answer: string;
}

export interface AgentToolInteractionSummary {
  kind: AgentToolInteractionKind;
  decision: string;
  decisionLabel: string;
  decisionTone: AgentToolInteractionTone;
  remember: boolean;
  answers?: AgentToolInteractionAnswer[];
  content?: Record<string, unknown> | null;
  requestSnapshot?: Record<string, unknown> | null;
  createdAt: string;
  resolvedAt: string;
}

export interface AgentTranscriptItem {
  id: string;
  kind: AgentTranscriptItemKind;
  contentType?: 'message' | 'plan';
  content?: string;
  images?: AgentTranscriptImage[];
  toolUseId?: string;
  parentToolUseId?: string;
  toolName?: string;
  providerToolName?: string;
  toolKind?: AgentToolKind;
  toolDisplayName?: string;
  toolInput?: unknown;
  providerToolInput?: unknown;
  interaction?: AgentToolInteractionSummary;
  isError?: boolean;
  isSynthetic?: boolean;
  sourceMessageId?: string;
  transcriptMessageId?: string;
  timestamp: string;
  authoredAt?: string;
  receivedAt?: string;
}

export interface AgentTranscriptImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: string;
}

export interface AgentPermissionRuleValue {
  toolName: string;
  ruleContent?: string;
}

export type AgentPermissionUpdate =
  | {
      type: 'addRules' | 'replaceRules' | 'removeRules';
      rules: AgentPermissionRuleValue[];
      behavior: string;
      destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';
    }
  | {
      type: 'setMode';
      mode: AgentPermissionMode;
      destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';
    }
  | {
      type: 'addDirectories' | 'removeDirectories';
      directories: string[];
      destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';
    };

export interface AgentPermissionRequest {
  requestId: string;
  toolUseId: string;
  toolName: string;
  providerToolName?: string;
  toolKind?: AgentToolKind;
  toolDisplayName?: string;
  input: unknown;
  providerInput?: unknown;
  agentId?: string;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  suggestions?: AgentPermissionUpdate[];
  batch?: AgentPermissionBatchItem[];
  createdAt: string;
}

export interface AgentPermissionBatchItem {
  toolUseId: string;
  toolName: string;
  toolDisplayName?: string;
  input: unknown;
}

export interface AgentPermissionApproval {
  remember: boolean;
  content?: Record<string, unknown>;
}

export interface AgentJsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  properties?: Record<string, AgentJsonSchema>;
  required?: string[];
  items?: AgentJsonSchema;
  oneOf?: AgentJsonSchema[];
  anyOf?: AgentJsonSchema[];
  format?: string;
  examples?: unknown[];
}

export interface AgentUserInputRequest {
  requestId: string;
  isBlocking?: boolean;
  serverName: string;
  message: string;
  mode?: 'form' | 'url';
  url?: string;
  elicitationId?: string;
  requestedSchema?: AgentJsonSchema;
  questions?: {
    id?: string;
    question: string;
    header?: string;
    options: {
      label: string;
      description?: string;
      preview?: string;
    }[];
    multiSelect?: boolean;
  }[];
  title?: string;
  displayName?: string;
  description?: string;
  createdAt: string;
}

export type AgentAutocompleteItemKind = 'command' | 'skill';

export interface AgentAutocompleteItem {
  id: string;
  kind: AgentAutocompleteItemKind;
  trigger: '/' | '$';
  label: string;
  insertText: string;
  description: string;
  detail?: string;
  source: 'builtin' | 'project' | 'user' | 'runtime';
}

export interface AgentModelOption {
  id: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
  /**
   * Thinking levels this specific model accepts, when the provider reports
   * them. Absent means "unknown" — fall back to the provider-wide list.
   */
  reasoningEfforts?: string[];
  /** True for the model the provider itself falls back to. */
  isProviderDefault?: boolean;
}

export interface AgentContextUsage {
  model: string | null;
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  /** Latest response input, including cache reads and writes. */
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** False when the harness has not reported response-level usage. */
  tokenBreakdownAvailable?: boolean;
  autoCompactThreshold?: number;
  isAutoCompactEnabled?: boolean;
  memoryFiles: {
    path: string;
    type: string;
    tokens: number;
  }[];
  mcpTools: {
    name: string;
    serverName: string;
    tokens: number;
    isLoaded?: boolean;
  }[];
}

export interface AgentRuntimeSessionMetadata {
  cwd: string;
  model: string;
  permissionMode: AgentPermissionMode;
  claudeCodeVersion: string;
  outputStyle: string;
  apiKeySource: string;
  tools: string[];
  slashCommands: string[];
  skills: string[];
  agents: string[];
  fastModeState: AgentFastModeState | null;
  mcpServers: {
    name: string;
    status: string;
  }[];
  plugins: {
    name: string;
    path: string;
    source?: string;
  }[];
}

export type AgentMcpScope = 'project' | 'local' | 'user' | 'enterprise' | 'runtime';
export type AgentMcpTransport =
  | 'stdio'
  | 'sse'
  | 'http'
  | 'ws'
  | 'sdk'
  | 'claudeai-proxy'
  | 'unknown';
export type AgentMcpConnectionStatus =
  | 'connected'
  | 'failed'
  | 'needs-auth'
  | 'disabled'
  | 'unknown';
export type AgentMcpConfigStatus = 'valid' | 'warning' | 'error';

export interface AgentMcpServerEntry {
  entryId: string;
  name: string;
  scope: AgentMcpScope;
  transport: AgentMcpTransport;
  configLocation: string;
  enabled: boolean;
  connectionStatus: AgentMcpConnectionStatus;
  configStatus: AgentMcpConfigStatus;
  error?: string;
  serverInfo?: {
    name: string;
    version: string;
  };
  counts?: {
    tools: number;
    resources: number;
    prompts: number;
    loadedContextTools: number;
  };
  tools?: {
    name: string;
    displayName: string;
  }[];
  actions: {
    canToggle: boolean;
    canRecheck: boolean;
    canAuth: boolean;
    canReauth: boolean;
    canViewTools: boolean;
  };
}

export interface AgentMcpDiagnosticMessage {
  serverName?: string;
  path?: string;
  message: string;
}

export interface AgentMcpDiagnosticGroup {
  scope: AgentMcpScope;
  configLocation: string;
  errors: AgentMcpDiagnosticMessage[];
  warnings: AgentMcpDiagnosticMessage[];
}

export interface AgentMcpSnapshot {
  servers: AgentMcpServerEntry[];
  diagnostics: AgentMcpDiagnosticGroup[];
  summary: {
    connected: number;
    needsAuth: number;
    failed: number;
    disabled: number;
    malformed: number;
    total: number;
  };
  lastUpdatedAt: string;
}

export interface AgentMcpAuthStartResult {
  serverName: string;
  url: string;
  mode: 'external';
  message: string;
}

export interface AgentRuntimeStatus {
  status: 'compacting' | 'requesting' | null;
  permissionMode?: AgentPermissionMode;
  compactResult?: 'success' | 'failed';
  compactError?: string;
}

export interface AgentRateLimit {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'overage';
  utilization?: number;
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
  overageResetsAt?: number;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
}

export interface AgentNotification {
  key: string;
  text: string;
  priority: 'low' | 'medium' | 'high' | 'immediate';
  color?: string;
  timeoutMs?: number;
  timestamp: string;
}

export interface AgentApiRetry {
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  errorStatus: number | null;
  error: string;
  timestamp: string;
}

export interface AgentPluginInstallProgress {
  status: 'started' | 'installed' | 'failed' | 'completed';
  name?: string;
  error?: string;
  timestamp: string;
}

export interface AgentHookEvent {
  eventName: string;
  claudeSessionId?: string;
  cwd?: string;
  permissionMode?: string;
  agentId?: string;
  agentType?: string;
  timestamp: string;
  raw: Record<string, unknown>;
}

export interface AgentHookExecution {
  hookId: string;
  hookName: string;
  hookEvent: string;
  status: 'running' | 'success' | 'error' | 'cancelled';
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  startedAt?: string;
  updatedAt: string;
}

export interface AgentTaskUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

export interface AgentTaskState {
  taskId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'stopped';
  description?: string;
  taskType?: string;
  workflowName?: string;
  toolUseId?: string;
  prompt?: string;
  outputFile?: string;
  summary?: string;
  lastToolName?: string;
  usage?: AgentTaskUsage;
  skipTranscript?: boolean;
  error?: string;
  endTime?: number;
  totalPausedMs?: number;
  isBackgrounded?: boolean;
  subject?: string;
  teammateName?: string;
  teamName?: string;
  updatedAt: string;
}

export interface AgentTaskLifecycle {
  taskId: string;
  event: 'created' | 'completed';
  subject: string;
  description?: string;
  teammateName?: string;
  teamName?: string;
  timestamp: string;
}

export interface AgentSubagentState {
  agentId: string;
  agentType: string;
  status: 'started' | 'stopped';
  transcriptPath?: string;
  stopHookActive?: boolean;
  lastAssistantMessage?: string;
  timestamp: string;
}

/**
 * A unit of work still executing in the background — a `run_in_background`
 * agent/task, or a subagent that started but has not reported back yet. These
 * outlive the turn that launched them, so the UI surfaces them independently of
 * `runPhase`.
 */
export interface AgentBackgroundWorkItem {
  /** Stable key: `subagent:<agentId>` or `task:<taskId>`. */
  id: string;
  kind: 'subagent' | 'task';
  label: string;
  detail?: string;
  startedAt: string;
  updatedAt: string;
}

export interface AgentSubagentHistoryPayload {
  subagent: AgentSubagentState;
  history: AgentTranscriptItem[];
  transcriptAvailable: boolean;
  transcriptError?: string;
}

export interface AgentToolProgress {
  toolUseId: string;
  toolName: string;
  parentToolUseId: string | null;
  elapsedTimeSeconds: number;
  taskId?: string;
  timestamp: string;
}

export interface AgentToolUseSummary {
  summary: string;
  precedingToolUseIds: string[];
  timestamp: string;
}

export interface AgentMemoryRecall {
  mode: 'select' | 'synthesize';
  memories: {
    path: string;
    scope: 'personal' | 'team';
    content?: string;
  }[];
  timestamp: string;
}

export interface AgentFilesPersisted {
  files: {
    filename: string;
    fileId: string;
  }[];
  failed: {
    filename: string;
    error: string;
  }[];
  processedAt: string;
  timestamp: string;
}

export interface AgentElicitationCompletion {
  serverName: string;
  elicitationId: string;
  timestamp: string;
}

export interface AgentPromptSuggestion {
  suggestion: string;
  timestamp: string;
}

export interface AgentCompactBoundary {
  trigger: 'manual' | 'auto';
  preTokens: number;
  postTokens?: number;
  durationMs?: number;
  preservedSegment?: {
    headUuid: string;
    anchorUuid: string;
    tailUuid: string;
  };
  timestamp: string;
}

export interface AgentMirrorError {
  error: string;
  key: {
    projectKey: string;
    sessionId: string;
    subpath?: string;
  };
  timestamp: string;
}

export interface AgentPendingPrompt {
  id: string;
  prompt: string;
  queuedAt: string;
}

export interface AgentRuntimePromptTiming {
  runId: string;
  startedAt: string;
  queryCreatedToFirstSdkMs: number | null;
  firstSdkToFirstVisibleMs: number | null;
  submitToFirstVisibleMs: number | null;
  preVisibleSummary: 'system_only' | 'tooling' | 'auth_or_mcp' | 'opaque';
  systemSubtypes: string[];
}

export interface AgentRuntimeState {
  sessionId: number;
  claudeSessionId: string | null;
  runPhase: AgentRunPhase;
  sessionState: AgentSessionExecutionState;
  canInterrupt: boolean;
  backgroundWork?: AgentBackgroundWorkItem[];
  backgroundRunActive?: boolean;
  pendingPermissionRequest: AgentPermissionRequest | null;
  pendingUserInputRequest: AgentUserInputRequest | null;
  pendingPrompts: AgentPendingPrompt[];
  queuePaused: boolean;
  liveItems: AgentTranscriptItem[];
  lastError: string | null;
  selectedModel: string | null;
  reasoningEffort: AgentReasoningEffort | null;
  fastMode: boolean;
  permissionMode: AgentPermissionMode | null;
  planMode: boolean;
  availableModels: AgentModelOption[];
  contextUsage: AgentContextUsage | null;
  sessionMetadata: AgentRuntimeSessionMetadata | null;
  runtimeStatus: AgentRuntimeStatus | null;
  authStatus: AgentAuthStatus | null;
  rateLimit: AgentRateLimit | null;
  planUsage?: AgentPlanUsage | null;
  notifications: AgentNotification[];
  hooks: AgentHookExecution[];
  recentHookEvents: AgentHookEvent[];
  tasks: AgentTaskState[];
  taskLifecycle: AgentTaskLifecycle[];
  subagents: AgentSubagentState[];
  latestToolProgress: AgentToolProgress | null;
  latestToolSummary: AgentToolUseSummary | null;
  latestApiRetry: AgentApiRetry | null;
  latestPluginInstall: AgentPluginInstallProgress | null;
  latestMemoryRecall: AgentMemoryRecall | null;
  latestFilesPersisted: AgentFilesPersisted | null;
  latestElicitationCompletion: AgentElicitationCompletion | null;
  latestPromptSuggestion: AgentPromptSuggestion | null;
  latestCompactBoundary: AgentCompactBoundary | null;
  latestMirrorError: AgentMirrorError | null;
  warmState: AgentRuntimeWarmState;
  lastWarmedAt: string | null;
  lastPromptTiming: AgentRuntimePromptTiming | null;
}

export interface AgentSessionSnapshot extends AgentRuntimeState {
  history: AgentTranscriptItem[];
}

export type AgentRuntimeEvent =
  | { type: 'session_snapshot'; payload: AgentSessionSnapshot }
  | { type: 'runtime_snapshot'; payload: AgentRuntimeState }
  | { type: 'history_snapshot'; payload: { sessionId: number; history: AgentTranscriptItem[] } }
  | {
      type: 'runtime_warm_state';
      payload: {
        sessionId: number;
        warmState: AgentRuntimeWarmState;
        lastWarmedAt: string | null;
      };
    }
  | { type: 'session_created'; payload: { sessionId: number; claudeSessionId: string } }
  | {
      type: 'run_state';
      payload: {
        sessionId: number;
        runPhase: AgentRunPhase;
        sessionState: AgentSessionExecutionState;
        canInterrupt: boolean;
        backgroundWork?: AgentBackgroundWorkItem[];
        backgroundRunActive?: boolean;
        lastError: string | null;
        selectedModel: string | null;
        reasoningEffort: AgentReasoningEffort | null;
        fastMode: boolean;
        permissionMode: AgentPermissionMode | null;
        planMode: boolean;
        availableModels: AgentModelOption[];
        contextUsage: AgentContextUsage | null;
        planUsage?: AgentPlanUsage | null;
        pendingPermissionRequest: AgentPermissionRequest | null;
        pendingUserInputRequest: AgentUserInputRequest | null;
        pendingPrompts: AgentPendingPrompt[];
        queuePaused: boolean;
      };
    }
  | {
      type: 'session_metadata';
      payload: { sessionId: number; metadata: AgentRuntimeSessionMetadata };
    }
  | { type: 'runtime_status'; payload: { sessionId: number; status: AgentRuntimeStatus } }
  | { type: 'auth_status'; payload: { sessionId: number; status: AgentAuthStatus } }
  | { type: 'rate_limit'; payload: { sessionId: number; rateLimit: AgentRateLimit } }
  | {
      type: 'plan_usage';
      payload: {
        sessionId: number;
        planUsage: AgentPlanUsage | null;
      };
    }
  | { type: 'notification'; payload: { sessionId: number; notification: AgentNotification } }
  | { type: 'api_retry'; payload: { sessionId: number; retry: AgentApiRetry } }
  | {
      type: 'plugin_install';
      payload: { sessionId: number; progress: AgentPluginInstallProgress };
    }
  | { type: 'hook_event'; payload: { sessionId: number; hookEvent: AgentHookEvent } }
  | { type: 'hook_started'; payload: { sessionId: number; hook: AgentHookExecution } }
  | { type: 'hook_progress'; payload: { sessionId: number; hook: AgentHookExecution } }
  | { type: 'hook_complete'; payload: { sessionId: number; hook: AgentHookExecution } }
  | { type: 'task_started'; payload: { sessionId: number; task: AgentTaskState } }
  | { type: 'task_updated'; payload: { sessionId: number; task: AgentTaskState } }
  | { type: 'task_progress'; payload: { sessionId: number; task: AgentTaskState } }
  | { type: 'task_notification'; payload: { sessionId: number; task: AgentTaskState } }
  | { type: 'task_lifecycle'; payload: { sessionId: number; taskLifecycle: AgentTaskLifecycle } }
  | { type: 'subagent_lifecycle'; payload: { sessionId: number; subagent: AgentSubagentState } }
  | {
      type: 'background_work';
      payload: { sessionId: number; backgroundWork: AgentBackgroundWorkItem[] };
    }
  | { type: 'tool_progress'; payload: { sessionId: number; progress: AgentToolProgress } }
  | { type: 'tool_summary'; payload: { sessionId: number; summary: AgentToolUseSummary } }
  | { type: 'memory_recall'; payload: { sessionId: number; recall: AgentMemoryRecall } }
  | { type: 'files_persisted'; payload: { sessionId: number; files: AgentFilesPersisted } }
  | {
      type: 'elicitation_complete';
      payload: { sessionId: number; completion: AgentElicitationCompletion };
    }
  | {
      type: 'prompt_suggestion';
      payload: { sessionId: number; suggestion: AgentPromptSuggestion };
    }
  | { type: 'compact_boundary'; payload: { sessionId: number; boundary: AgentCompactBoundary } }
  | { type: 'mirror_error'; payload: { sessionId: number; error: AgentMirrorError } }
  | { type: 'message_start'; payload: { sessionId: number; item: AgentTranscriptItem } }
  | { type: 'message_delta'; payload: { sessionId: number; itemId: string; delta: string } }
  | { type: 'message_complete'; payload: { sessionId: number; itemId: string } }
  | { type: 'thinking_start'; payload: { sessionId: number; item: AgentTranscriptItem } }
  | { type: 'thinking_delta'; payload: { sessionId: number; itemId: string; delta: string } }
  | { type: 'thinking_complete'; payload: { sessionId: number; itemId: string } }
  | { type: 'tool_use'; payload: { sessionId: number; item: AgentTranscriptItem } }
  | { type: 'tool_result'; payload: { sessionId: number; item: AgentTranscriptItem } }
  | { type: 'permission_request'; payload: { sessionId: number; request: AgentPermissionRequest } }
  | {
      type: 'permission_resolved';
      payload: {
        sessionId: number;
        requestId: string;
        toolUseId: string;
        decision: 'approved' | 'approved_always' | 'denied';
        interaction: AgentToolInteractionSummary;
      };
    }
  | { type: 'user_input_request'; payload: { sessionId: number; request: AgentUserInputRequest } }
  | { type: 'error'; payload: { sessionId: number; message: string } }
  | { type: 'complete'; payload: { sessionId: number } };
