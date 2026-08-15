import type {
  ClaudeAuthStatus,
  ClaudeContextUsage,
  ClaudeModelOption,
  ClaudePermissionMode,
  ClaudePermissionRequest,
  ClaudeRuntimeSessionMetadata,
  ClaudeRuntimeStatePayload,
  ClaudeTranscriptItem,
  ClaudeUserInputRequest,
} from '../claude-runtime/claude-runtime.types.js';
import type {
  AgentImageInput,
  AgentLoginMode,
} from '../agent-runtime/agent-runtime.types.js';

export type GeminiRunPhase = 'idle' | 'running' | 'waiting' | 'error';

/* -------------------------------------------------------------------------- */
/* Agent Client Protocol (ACP) wire types                                      */
/* -------------------------------------------------------------------------- */

/** Protocol revision Elevenex negotiates. gemini-cli 0.55 answers with `1`. */
export const ACP_PROTOCOL_VERSION = 1;

export interface AcpAuthMethod {
  id: string;
  name: string;
  description?: string;
  _meta?: Record<string, unknown>;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  authMethods?: AcpAuthMethod[];
  agentInfo?: { name?: string; title?: string; version?: string };
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: {
      image?: boolean;
      audio?: boolean;
      embeddedContext?: boolean;
    };
    mcpCapabilities?: { http?: boolean; sse?: boolean };
  };
}

export interface AcpModeDescriptor {
  id: string;
  name?: string;
  description?: string;
}

export interface AcpModelDescriptor {
  modelId: string;
  name?: string;
  description?: string;
}

export interface AcpNewSessionResult {
  sessionId: string;
  modes?: {
    availableModes?: AcpModeDescriptor[];
    currentModeId?: string;
  };
  models?: {
    availableModels?: AcpModelDescriptor[];
    currentModelId?: string;
  };
}

export type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'audio'; mimeType: string; data: string }
  | { type: 'resource_link'; uri: string; name?: string }
  | { type: 'resource'; resource: Record<string, unknown> };

/**
 * ACP tool kinds. Gemini emits these on `tool_call`; they are mapped onto the
 * shared `AgentToolKind` in gemini-transcript.ts.
 */
export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type AcpToolCallStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed';

export type AcpToolCallContent =
  | { type: 'content'; content: AcpContentBlock }
  | { type: 'diff'; path: string; oldText?: string | null; newText: string }
  | { type: 'terminal'; terminalId: string };

export interface AcpToolCall {
  toolCallId: string;
  title?: string;
  kind?: AcpToolKind;
  status?: AcpToolCallStatus;
  content?: AcpToolCallContent[];
  locations?: { path: string; line?: number }[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface AcpPlanEntry {
  content: string;
  priority?: 'high' | 'medium' | 'low';
  status?: 'pending' | 'in_progress' | 'completed';
}

export interface AcpAvailableCommand {
  name: string;
  description?: string;
  input?: { hint?: string } | null;
}

export type AcpSessionUpdate =
  | { sessionUpdate: 'user_message_chunk'; content: AcpContentBlock }
  | { sessionUpdate: 'agent_message_chunk'; content: AcpContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: AcpContentBlock }
  | ({ sessionUpdate: 'tool_call' } & AcpToolCall)
  | ({ sessionUpdate: 'tool_call_update' } & AcpToolCall)
  | { sessionUpdate: 'plan'; entries: AcpPlanEntry[] }
  | {
      sessionUpdate: 'available_commands_update';
      availableCommands: AcpAvailableCommand[];
    }
  | { sessionUpdate: 'current_mode_update'; currentModeId: string };

export interface AcpSessionNotification {
  sessionId: string;
  update: AcpSessionUpdate;
}

export type AcpPermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind?: AcpPermissionOptionKind;
}

export interface AcpRequestPermissionParams {
  sessionId: string;
  toolCall: AcpToolCall;
  options: AcpPermissionOption[];
}

export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

export interface AcpPromptResult {
  stopReason?: AcpStopReason;
}

/* -------------------------------------------------------------------------- */
/* Elevenex-side runtime types                                                 */
/* -------------------------------------------------------------------------- */

export type GeminiAuthMethodId =
  | 'oauth-personal'
  | 'gemini-api-key'
  | 'vertex-ai'
  | 'gateway';

export interface GeminiAuthStatus extends ClaudeAuthStatus {
  [key: string]: unknown;
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  authMethod: 'api_key' | 'oauth' | 'vertex' | 'gateway' | 'none' | 'unknown';
  authPath: string;
  availableMethods: AcpAuthMethod[];
  loginMode?: AgentLoginMode | null;
  loginUrl?: string | null;
  loginUserCode?: string | null;
  loginError?: string | null;
  installHint?: string | null;
}

export interface GeminiRuntimeSessionMetadata extends Omit<
  ClaudeRuntimeSessionMetadata,
  'claudeCodeVersion' | 'apiKeySource' | 'plugins'
> {
  geminiVersion: string;
  authMethod: string;
  plugins: [];
}

export interface GeminiRuntimeStatePayload extends Omit<
  ClaudeRuntimeStatePayload,
  'sessionMetadata' | 'authStatus'
> {
  sessionMetadata: GeminiRuntimeSessionMetadata | null;
  authStatus: GeminiAuthStatus | ClaudeAuthStatus | null;
}

export interface GeminiSessionSnapshotPayload extends GeminiRuntimeStatePayload {
  history: ClaudeTranscriptItem[];
}

/** A permission request awaiting the user, keyed by our own request id. */
export interface GeminiPendingPermission {
  request: ClaudePermissionRequest;
  /** JSON-RPC id of the `session/request_permission` call to answer. */
  rpcRequestId: number | string;
  options: AcpPermissionOption[];
}

export interface GeminiRuntimeState {
  /** ACP session id, persisted to `sessions.gemini_session_id`. */
  geminiSessionId: string | null;
  cachedWorktreePath: string | null;
  runPhase: GeminiRunPhase;
  sessionState: 'idle' | 'running' | 'requires_action' | null;
  canInterrupt: boolean;
  pendingPrompts: {
    id: string;
    prompt: string;
    queuedAt: string;
    images?: AgentImageInput[];
  }[];
  liveItems: ClaudeTranscriptItem[];
  /**
   * Stable id for the assistant message / thought currently being streamed.
   * ACP delivers prose as a series of `*_chunk` updates with no message id, so
   * without this every chunk would land as its own transcript entry.
   */
  streamingAssistantMessageId: string | null;
  streamingThoughtMessageId: string | null;
  pendingPermissionRequest: ClaudePermissionRequest | null;
  pendingUserInputRequest: ClaudeUserInputRequest | null;
  lastError: string | null;
  selectedModel: string | null;
  reasoningEffort: string | null;
  fastMode: boolean;
  permissionMode: ClaudePermissionMode | null;
  planMode: boolean;
  availableModels: ClaudeModelOption[];
  availableModes: AcpModeDescriptor[];
  availableCommands: AcpAvailableCommand[];
  contextUsage: ClaudeContextUsage | null;
  sessionMetadata: GeminiRuntimeSessionMetadata | null;
  authStatus: GeminiAuthStatus | null;
}

export interface GeminiSessionRuntimeExit {
  message: string;
  stderr: string;
  pid?: number;
}
