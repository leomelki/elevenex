export type AgentProviderId = 'claude' | 'codex' | 'pi' | 'opencode' | string;
export type AgentPermissionMode = string;

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

export interface AgentRuntimeState {
  sessionId: number;
}

export interface AgentRuntimeEvent {
  type: string;
  payload: {
    sessionId: number;
  };
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

export type AgentImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface AgentImageInput {
  mediaType: AgentImageMediaType;
  data: string;
}
