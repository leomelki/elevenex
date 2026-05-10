import { EventEmitter } from 'events';

export type AgentProviderId = 'claude' | 'codex' | 'pi' | 'opencode' | string;
export type AgentPermissionMode = string;
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
}

export interface AgentRuntimeProviderInfo {
  id: AgentProviderId;
  displayName: string;
  capabilities: AgentRuntimeProviderCapabilities;
}

export interface AgentRuntimeStatePayload {
  sessionId: number;
}

export interface AgentSessionSnapshotPayload extends AgentRuntimeStatePayload {
  history: AgentTranscriptItem[];
}

export type AgentTranscriptItem = unknown;

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
  history: AgentTranscriptItem[];
  transcriptAvailable: boolean;
}

export interface AgentMcpSnapshot {
  servers: unknown[];
  diagnostics: unknown[];
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
  authUrl?: string;
  message?: string;
}

export interface AgentAuthStatus {
  isAuthenticating: boolean;
  output: string[];
  error?: string;
  [key: string]: unknown;
}

export interface AgentImageInput {
  mediaType: AgentImageMediaType;
  data: string;
}

export interface AgentRuntimeProviderBase extends EventEmitter {
  readonly info: AgentRuntimeProviderInfo;

  getHistory(sessionId: number): Promise<AgentTranscriptItem[]>;
  getRuntimeState(sessionId: number): Promise<AgentRuntimeStatePayload>;
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
  ): Promise<void>;
  interrupt(sessionId: number): Promise<void>;
  cancelPendingPrompt(sessionId: number, id: string): Promise<void>;
  cleanupSession(sessionId: number): Promise<void>;
}

export type AgentLoginMode = 'oauth' | 'api_key';

export interface AgentLoginStartResult {
  mode: AgentLoginMode;
  authUrl: string | null;
  message: string;
}

export interface AgentRuntimeProviderFeatures {
  getAuthStatus(): Promise<AgentAuthStatus>;
  startLogin(options: {
    mode: AgentLoginMode;
    apiKey?: string;
  }): Promise<AgentLoginStartResult>;
  cancelLogin(): Promise<AgentAuthStatus>;
  getSubagentHistory(
    sessionId: number,
    agentId: string,
  ): Promise<AgentSubagentHistoryPayload>;
  getMcpSnapshot(
    sessionId: number,
    forceRefresh?: boolean,
  ): Promise<AgentMcpSnapshot>;
  toggleMcpServer(
    sessionId: number,
    serverName: string,
  ): Promise<AgentMcpSnapshot>;
  recheckMcpServer(
    sessionId: number,
    serverName: string,
  ): Promise<AgentMcpSnapshot>;
  startMcpAuth(
    sessionId: number,
    serverName: string,
  ): Promise<AgentMcpAuthStartResult>;
  setPermissionMode(
    sessionId: number,
    mode: AgentPermissionMode | null,
  ): Promise<AgentRuntimeStatePayload>;

  openTerminalFallback(sessionId: number): Promise<unknown>;
  rewindConversation(
    sessionId: number,
    messageId: string,
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
}

export type AgentRuntimeProvider = AgentRuntimeProviderBase &
  Partial<AgentRuntimeProviderFeatures>;

export interface AgentRuntimeCleanup {
  cleanupSession(sessionId: number): Promise<void>;
}
