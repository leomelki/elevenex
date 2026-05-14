import type {
  ClaudeAuthStatus,
  ClaudeContextUsage,
  ClaudeModelOption,
  ClaudeRuntimeSessionMetadata,
  ClaudeRuntimeStatePayload,
  ClaudeSessionSnapshotPayload,
  ClaudeTranscriptItem,
  ClaudeUserInputRequest,
} from '../claude-runtime/claude-runtime.types.js';
import type { AgentImageInput, AgentLoginMode } from '../agent-runtime/agent-runtime.types.js';

export type PiRunPhase = 'idle' | 'running' | 'waiting' | 'error';

export type PiOAuthProvider = 'anthropic' | 'github-copilot' | 'openai-codex';
export type PiApiKeyProvider = 'anthropic' | 'openai' | 'google' | 'openrouter';

export interface PiAuthStatus extends ClaudeAuthStatus {
  [key: string]: unknown;
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  authMethod: 'api_key' | 'oauth' | 'none' | 'unknown';
  authPath: string;
  modelsPath: string;
  loginMode?: AgentLoginMode | null;
  loginUrl?: string | null;
  loginUserCode?: string | null;
  loginError?: string | null;
}

export interface PiRuntimeSessionMetadata extends Omit<
  ClaudeRuntimeSessionMetadata,
  'claudeCodeVersion' | 'apiKeySource' | 'mcpServers' | 'agents' | 'plugins'
> {
  piVersion: string;
  authMethod: string;
  mcpServers: [];
  agents: [];
  plugins: [];
}

export interface PiRuntimeStatePayload extends Omit<
  ClaudeRuntimeStatePayload,
  'sessionMetadata' | 'permissionMode' | 'authStatus'
> {
  sessionMetadata: PiRuntimeSessionMetadata | null;
  permissionMode: null;
  authStatus: PiAuthStatus | ClaudeAuthStatus | null;
}

export interface PiSessionSnapshotPayload extends PiRuntimeStatePayload {
  history: ClaudeTranscriptItem[];
}

export interface PiRuntimeState {
  piSessionPath: string | null;
  cachedWorktreePath: string | null;
  runPhase: PiRunPhase;
  sessionState: 'idle' | 'running' | 'requires_action' | null;
  canInterrupt: boolean;
  pendingPrompts: {
    id: string;
    prompt: string;
    queuedAt: string;
    images?: AgentImageInput[];
  }[];
  liveItems: ClaudeTranscriptItem[];
  pendingUserInputRequest: ClaudeUserInputRequest | null;
  lastError: string | null;
  selectedModel: string | null;
  reasoningEffort: string | null;
  fastMode: boolean;
  availableModels: ClaudeModelOption[];
  contextUsage: ClaudeContextUsage | null;
  sessionMetadata: PiRuntimeSessionMetadata | null;
  authStatus: PiAuthStatus | null;
}

export interface PiSessionRuntimeEvent {
  type: string;
  [key: string]: unknown;
}

export interface PiRpcResponse {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface PiRpcExtensionUiRequest {
  type: 'extension_ui_request';
  id: string;
  method: string;
  [key: string]: unknown;
}
