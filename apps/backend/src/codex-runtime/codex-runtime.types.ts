import type {
  AgentImageInput,
} from '../agent-runtime/agent-runtime.types.js';
import type {
  ClaudeAuthStatus,
  ClaudeContextUsage,
  ClaudeMcpConfigStatus,
  ClaudeMcpConnectionStatus,
  ClaudeMcpDiagnosticMessage,
  ClaudeMcpScope,
  ClaudeMcpServerEntry,
  ClaudeMcpSnapshot,
  ClaudeMcpTransport,
  ClaudeModelOption,
  ClaudePermissionMode,
  ClaudeRuntimeEvent,
  ClaudeRuntimeSessionMetadata,
  ClaudeRuntimeStatePayload,
  ClaudeSessionSnapshotPayload,
  ClaudeTranscriptItem,
} from '../claude-runtime/claude-runtime.types.js';

export type CodexRunPhase = 'idle' | 'running' | 'waiting' | 'error';
export type CodexPermissionMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'bypassPermissions'
  | string;

export interface CodexRuntimeSessionMetadata
  extends Omit<
    ClaudeRuntimeSessionMetadata,
    'claudeCodeVersion' | 'outputStyle' | 'apiKeySource' | 'agents' | 'plugins'
  > {
  codexVersion: string;
  authMethod: string;
  agents: [];
  plugins: [];
}

export interface CodexRuntimeStatePayload
  extends Omit<
    ClaudeRuntimeStatePayload,
    'sessionMetadata' | 'permissionMode' | 'authStatus'
  > {
  sessionMetadata: CodexRuntimeSessionMetadata | null;
  permissionMode: CodexPermissionMode | ClaudePermissionMode | null;
  authStatus: CodexAuthStatus | ClaudeAuthStatus | null;
}

export interface CodexSessionSnapshotPayload
  extends CodexRuntimeStatePayload {
  history: ClaudeTranscriptItem[];
}

export interface CodexAuthStatus extends ClaudeAuthStatus {
  [key: string]: unknown;
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  authMethod: 'oauth' | 'api_key' | 'none' | 'unknown';
  email?: string;
  authPath: string;
  loginMode: 'oauth' | 'api_key' | null;
  loginUrl: string | null;
  loginUserCode: string | null;
  loginError: string | null;
}

export type CodexLoginMode = 'oauth' | 'api_key';

export interface CodexLoginStartResult {
  mode: CodexLoginMode;
  authUrl: string | null;
  userCode: string | null;
  message: string;
}

export interface CodexActiveRunState {
  threadId: string | null;
  /** The active app-server turnId, captured from `turn/started`; needed for `turn/interrupt`. */
  turnId: string | null;
  abortController: AbortController;
  interruptRequested: boolean;
  completionPromise: Promise<void>;
  resolveCompletion: () => void;
  startedAtMs: number;
}

export interface CodexRuntimeState {
  codexSessionId: string | null;
  // Cached so follow-up prompts don't re-read the session row from SQLite on
  // the critical path. Populated on the first prompt of the session.
  cachedWorktreePath: string | null;
  runPhase: CodexRunPhase;
  sessionState: 'idle' | 'running' | 'requires_action' | null;
  canInterrupt: boolean;
  pendingPrompts: {
    id: string;
    prompt: string;
    queuedAt: string;
    images?: AgentImageInput[];
  }[];
  liveItems: ClaudeTranscriptItem[];
  lastError: string | null;
  selectedModel: string | null;
  selectedPermissionMode: CodexPermissionMode | null;
  availableModels: ClaudeModelOption[];
  contextUsage: ClaudeContextUsage | null;
  sessionMetadata: CodexRuntimeSessionMetadata | null;
  authStatus: CodexAuthStatus | null;
}

export interface CodexHistorySessionSummary {
  id: string;
  cwd: string | null;
  model: string | null;
  summary: string | null;
  messageCount: number;
  lastTimestamp: string | null;
  path: string;
}

export type CodexRuntimeEvent = ClaudeRuntimeEvent;

export type CodexMcpScope = Extract<ClaudeMcpScope, 'user' | 'project'>;
export type CodexMcpTransport = Extract<ClaudeMcpTransport, 'stdio' | 'http'>;
export type CodexMcpConfigStatus = ClaudeMcpConfigStatus;
export type CodexMcpConnectionStatus = ClaudeMcpConnectionStatus;
export type CodexMcpDiagnosticMessage = ClaudeMcpDiagnosticMessage;
export type CodexMcpServerEntry = ClaudeMcpServerEntry;
export type CodexMcpSnapshot = ClaudeMcpSnapshot;
