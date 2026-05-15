export type ClaudeRunPhase = 'idle' | 'running' | 'waiting' | 'error';
export type ClaudeSessionExecutionState = 'idle' | 'running' | 'requires_action' | null;
export type ClaudePermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto'
  | string;
export type ClaudeFastModeState = 'off' | 'cooldown' | 'on';
export type ClaudeReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | string;

export type ClaudeTranscriptItemKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'system'
  | 'error';

export type ClaudeToolInteractionKind =
  | 'permission'
  | 'ask_user_question'
  | 'plan_mode'
  | 'exit_plan_mode';

export type ClaudeToolInteractionTone = 'ok' | 'warn' | 'neutral';

export interface ClaudeToolInteractionAnswer {
  question: string;
  answer: string;
}

export interface ClaudeToolInteractionSummary {
  kind: ClaudeToolInteractionKind;
  decision: string;
  decisionLabel: string;
  decisionTone: ClaudeToolInteractionTone;
  remember: boolean;
  answers?: ClaudeToolInteractionAnswer[];
  content?: Record<string, unknown> | null;
  requestSnapshot?: Record<string, unknown> | null;
  createdAt: string;
  resolvedAt: string;
}

export interface ClaudeTranscriptItem {
  id: string;
  kind: ClaudeTranscriptItemKind;
  content?: string;
  toolUseId?: string;
  parentToolUseId?: string;
  toolName?: string;
  toolInput?: unknown;
  interaction?: ClaudeToolInteractionSummary;
  isError?: boolean;
  sourceMessageId?: string;
  timestamp: string;
  authoredAt?: string;
  receivedAt?: string;
}

export interface ClaudePermissionRuleValue {
  toolName: string;
  ruleContent?: string;
}

export type ClaudePermissionUpdate =
  | {
      type: 'addRules' | 'replaceRules' | 'removeRules';
      rules: ClaudePermissionRuleValue[];
      behavior: string;
      destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';
    }
  | {
      type: 'setMode';
      mode: ClaudePermissionMode;
      destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';
    }
  | {
      type: 'addDirectories' | 'removeDirectories';
      directories: string[];
      destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';
    };

export interface ClaudePermissionRequest {
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: unknown;
  agentId?: string;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  suggestions?: ClaudePermissionUpdate[];
  createdAt: string;
}

export interface ClaudePermissionApproval {
  remember: boolean;
  content?: Record<string, unknown>;
}

export interface ClaudeJsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  properties?: Record<string, ClaudeJsonSchema>;
  required?: string[];
  items?: ClaudeJsonSchema;
  oneOf?: ClaudeJsonSchema[];
  anyOf?: ClaudeJsonSchema[];
  format?: string;
  examples?: unknown[];
}

export interface ClaudeUserInputRequest {
  requestId: string;
  serverName: string;
  message: string;
  mode?: 'form' | 'url';
  url?: string;
  elicitationId?: string;
  requestedSchema?: ClaudeJsonSchema;
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

export type ClaudeAutocompleteItemKind = 'command' | 'skill';

export interface ClaudeAutocompleteItem {
  id: string;
  kind: ClaudeAutocompleteItemKind;
  trigger: '/' | '$';
  label: string;
  insertText: string;
  description: string;
  detail?: string;
  source: 'builtin' | 'project' | 'user' | 'runtime';
}

export interface ClaudeModelOption {
  id: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}

export interface ClaudeContextUsage {
  model: string | null;
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
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

export interface ClaudeRuntimeSessionMetadata {
  cwd: string;
  model: string;
  permissionMode: ClaudePermissionMode;
  claudeCodeVersion: string;
  outputStyle: string;
  apiKeySource: string;
  tools: string[];
  slashCommands: string[];
  skills: string[];
  agents: string[];
  fastModeState: ClaudeFastModeState | null;
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

export type ClaudeMcpScope = 'project' | 'local' | 'user' | 'enterprise' | 'runtime';
export type ClaudeMcpTransport =
  | 'stdio'
  | 'sse'
  | 'http'
  | 'ws'
  | 'sdk'
  | 'claudeai-proxy'
  | 'unknown';
export type ClaudeMcpConnectionStatus =
  | 'connected'
  | 'failed'
  | 'needs-auth'
  | 'disabled'
  | 'unknown';
export type ClaudeMcpConfigStatus = 'valid' | 'warning' | 'error';

export interface ClaudeMcpServerEntry {
  entryId: string;
  name: string;
  scope: ClaudeMcpScope;
  transport: ClaudeMcpTransport;
  configLocation: string;
  enabled: boolean;
  connectionStatus: ClaudeMcpConnectionStatus;
  configStatus: ClaudeMcpConfigStatus;
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

export interface ClaudeMcpDiagnosticMessage {
  serverName?: string;
  path?: string;
  message: string;
}

export interface ClaudeMcpDiagnosticGroup {
  scope: ClaudeMcpScope;
  configLocation: string;
  errors: ClaudeMcpDiagnosticMessage[];
  warnings: ClaudeMcpDiagnosticMessage[];
}

export interface ClaudeMcpSnapshot {
  servers: ClaudeMcpServerEntry[];
  diagnostics: ClaudeMcpDiagnosticGroup[];
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

export interface ClaudeMcpAuthStartResult {
  serverName: string;
  url: string;
  mode: 'external';
  message: string;
}

export interface ClaudeRuntimeStatus {
  status: 'compacting' | 'requesting' | null;
  permissionMode?: ClaudePermissionMode;
  compactResult?: 'success' | 'failed';
  compactError?: string;
}

export interface ClaudeAuthStatus {
  isAuthenticating: boolean;
  output: string[];
  error?: string;
}

export interface ClaudeRateLimit {
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

export interface ClaudeNotification {
  key: string;
  text: string;
  priority: 'low' | 'medium' | 'high' | 'immediate';
  color?: string;
  timeoutMs?: number;
  timestamp: string;
}

export interface ClaudeApiRetry {
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  errorStatus: number | null;
  error: string;
  timestamp: string;
}

export interface ClaudePluginInstallProgress {
  status: 'started' | 'installed' | 'failed' | 'completed';
  name?: string;
  error?: string;
  timestamp: string;
}

export interface ClaudeHookEvent {
  eventName: string;
  claudeSessionId?: string;
  cwd?: string;
  permissionMode?: string;
  agentId?: string;
  agentType?: string;
  timestamp: string;
  raw: Record<string, unknown>;
}

export interface ClaudeHookExecution {
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

export interface ClaudeTaskUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

export interface ClaudeTaskState {
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
  usage?: ClaudeTaskUsage;
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

export interface ClaudeTaskLifecycle {
  taskId: string;
  event: 'created' | 'completed';
  subject: string;
  description?: string;
  teammateName?: string;
  teamName?: string;
  timestamp: string;
}

export interface ClaudeSubagentState {
  agentId: string;
  agentType: string;
  status: 'started' | 'stopped';
  transcriptPath?: string;
  stopHookActive?: boolean;
  lastAssistantMessage?: string;
  timestamp: string;
}

export interface ClaudeSubagentHistoryPayload {
  subagent: ClaudeSubagentState;
  history: ClaudeTranscriptItem[];
  transcriptAvailable: boolean;
  transcriptError?: string;
}

export interface ClaudeToolProgress {
  toolUseId: string;
  toolName: string;
  parentToolUseId: string | null;
  elapsedTimeSeconds: number;
  taskId?: string;
  timestamp: string;
}

export interface ClaudeToolUseSummary {
  summary: string;
  precedingToolUseIds: string[];
  timestamp: string;
}

export interface ClaudeMemoryRecall {
  mode: 'select' | 'synthesize';
  memories: {
    path: string;
    scope: 'personal' | 'team';
    content?: string;
  }[];
  timestamp: string;
}

export interface ClaudeFilesPersisted {
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

export interface ClaudeElicitationCompletion {
  serverName: string;
  elicitationId: string;
  timestamp: string;
}

export interface ClaudePromptSuggestion {
  suggestion: string;
  timestamp: string;
}

export interface ClaudeCompactBoundary {
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

export interface ClaudeMirrorError {
  error: string;
  key: {
    projectKey: string;
    sessionId: string;
    subpath?: string;
  };
  timestamp: string;
}

export interface ClaudePendingPrompt {
  id: string;
  prompt: string;
  queuedAt: string;
}

export interface ClaudeRuntimeState {
  sessionId: number;
  claudeSessionId: string | null;
  runPhase: ClaudeRunPhase;
  sessionState: ClaudeSessionExecutionState;
  canInterrupt: boolean;
  pendingPermissionRequest: ClaudePermissionRequest | null;
  pendingUserInputRequest: ClaudeUserInputRequest | null;
  pendingPrompts: ClaudePendingPrompt[];
  liveItems: ClaudeTranscriptItem[];
  lastError: string | null;
  selectedModel: string | null;
  reasoningEffort: ClaudeReasoningEffort | null;
  fastMode: boolean;
  permissionMode: ClaudePermissionMode | null;
  availableModels: ClaudeModelOption[];
  contextUsage: ClaudeContextUsage | null;
  sessionMetadata: ClaudeRuntimeSessionMetadata | null;
  runtimeStatus: ClaudeRuntimeStatus | null;
  authStatus: ClaudeAuthStatus | null;
  rateLimit: ClaudeRateLimit | null;
  notifications: ClaudeNotification[];
  hooks: ClaudeHookExecution[];
  recentHookEvents: ClaudeHookEvent[];
  tasks: ClaudeTaskState[];
  taskLifecycle: ClaudeTaskLifecycle[];
  subagents: ClaudeSubagentState[];
  latestToolProgress: ClaudeToolProgress | null;
  latestToolSummary: ClaudeToolUseSummary | null;
  latestApiRetry: ClaudeApiRetry | null;
  latestPluginInstall: ClaudePluginInstallProgress | null;
  latestMemoryRecall: ClaudeMemoryRecall | null;
  latestFilesPersisted: ClaudeFilesPersisted | null;
  latestElicitationCompletion: ClaudeElicitationCompletion | null;
  latestPromptSuggestion: ClaudePromptSuggestion | null;
  latestCompactBoundary: ClaudeCompactBoundary | null;
  latestMirrorError: ClaudeMirrorError | null;
}

export interface ClaudeSessionSnapshot extends ClaudeRuntimeState {
  history: ClaudeTranscriptItem[];
}

export type ClaudeRuntimeEvent =
  | { type: 'session_snapshot'; payload: ClaudeSessionSnapshot }
  | { type: 'session_created'; payload: { sessionId: number; claudeSessionId: string } }
  | {
      type: 'run_state';
      payload: {
        sessionId: number;
        runPhase: ClaudeRunPhase;
        sessionState: ClaudeSessionExecutionState;
        canInterrupt: boolean;
        lastError: string | null;
        selectedModel: string | null;
        reasoningEffort: ClaudeReasoningEffort | null;
        fastMode: boolean;
        permissionMode: ClaudePermissionMode | null;
        availableModels: ClaudeModelOption[];
        contextUsage: ClaudeContextUsage | null;
        pendingPermissionRequest: ClaudePermissionRequest | null;
        pendingUserInputRequest: ClaudeUserInputRequest | null;
        pendingPrompts: ClaudePendingPrompt[];
      };
    }
  | {
      type: 'session_metadata';
      payload: { sessionId: number; metadata: ClaudeRuntimeSessionMetadata };
    }
  | { type: 'runtime_status'; payload: { sessionId: number; status: ClaudeRuntimeStatus } }
  | { type: 'auth_status'; payload: { sessionId: number; status: ClaudeAuthStatus } }
  | { type: 'rate_limit'; payload: { sessionId: number; rateLimit: ClaudeRateLimit } }
  | { type: 'notification'; payload: { sessionId: number; notification: ClaudeNotification } }
  | { type: 'api_retry'; payload: { sessionId: number; retry: ClaudeApiRetry } }
  | {
      type: 'plugin_install';
      payload: { sessionId: number; progress: ClaudePluginInstallProgress };
    }
  | { type: 'hook_event'; payload: { sessionId: number; hookEvent: ClaudeHookEvent } }
  | { type: 'hook_started'; payload: { sessionId: number; hook: ClaudeHookExecution } }
  | { type: 'hook_progress'; payload: { sessionId: number; hook: ClaudeHookExecution } }
  | { type: 'hook_complete'; payload: { sessionId: number; hook: ClaudeHookExecution } }
  | { type: 'task_started'; payload: { sessionId: number; task: ClaudeTaskState } }
  | { type: 'task_updated'; payload: { sessionId: number; task: ClaudeTaskState } }
  | { type: 'task_progress'; payload: { sessionId: number; task: ClaudeTaskState } }
  | { type: 'task_notification'; payload: { sessionId: number; task: ClaudeTaskState } }
  | { type: 'task_lifecycle'; payload: { sessionId: number; taskLifecycle: ClaudeTaskLifecycle } }
  | { type: 'subagent_lifecycle'; payload: { sessionId: number; subagent: ClaudeSubagentState } }
  | { type: 'tool_progress'; payload: { sessionId: number; progress: ClaudeToolProgress } }
  | { type: 'tool_summary'; payload: { sessionId: number; summary: ClaudeToolUseSummary } }
  | { type: 'memory_recall'; payload: { sessionId: number; recall: ClaudeMemoryRecall } }
  | { type: 'files_persisted'; payload: { sessionId: number; files: ClaudeFilesPersisted } }
  | {
      type: 'elicitation_complete';
      payload: { sessionId: number; completion: ClaudeElicitationCompletion };
    }
  | {
      type: 'prompt_suggestion';
      payload: { sessionId: number; suggestion: ClaudePromptSuggestion };
    }
  | { type: 'compact_boundary'; payload: { sessionId: number; boundary: ClaudeCompactBoundary } }
  | { type: 'mirror_error'; payload: { sessionId: number; error: ClaudeMirrorError } }
  | { type: 'message_start'; payload: { sessionId: number; item: ClaudeTranscriptItem } }
  | { type: 'message_delta'; payload: { sessionId: number; itemId: string; delta: string } }
  | { type: 'message_complete'; payload: { sessionId: number; itemId: string } }
  | { type: 'thinking_start'; payload: { sessionId: number; item: ClaudeTranscriptItem } }
  | { type: 'thinking_delta'; payload: { sessionId: number; itemId: string; delta: string } }
  | { type: 'thinking_complete'; payload: { sessionId: number; itemId: string } }
  | { type: 'tool_use'; payload: { sessionId: number; item: ClaudeTranscriptItem } }
  | { type: 'tool_result'; payload: { sessionId: number; item: ClaudeTranscriptItem } }
  | { type: 'permission_request'; payload: { sessionId: number; request: ClaudePermissionRequest } }
  | {
      type: 'permission_resolved';
      payload: {
        sessionId: number;
        requestId: string;
        toolUseId: string;
        decision: 'approved' | 'approved_always' | 'denied';
        interaction: ClaudeToolInteractionSummary;
      };
    }
  | { type: 'user_input_request'; payload: { sessionId: number; request: ClaudeUserInputRequest } }
  | { type: 'error'; payload: { sessionId: number; message: string } }
  | { type: 'complete'; payload: { sessionId: number } };
