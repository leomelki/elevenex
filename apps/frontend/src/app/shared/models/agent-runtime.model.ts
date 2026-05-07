import type {
  ClaudeAutocompleteItem,
  ClaudeMcpAuthStartResult,
  ClaudeMcpSnapshot,
  ClaudeRuntimeEvent,
  ClaudeRuntimeState,
  ClaudeSubagentHistoryPayload,
  ClaudeTranscriptItem,
} from './claude-runtime.model';

export type AgentProviderId = 'claude' | 'codex' | 'pi' | 'opencode' | string;

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

export type AgentRuntimeState = ClaudeRuntimeState;
export type AgentRuntimeEvent = ClaudeRuntimeEvent;
export type AgentTranscriptItem = ClaudeTranscriptItem;
export type AgentAutocompleteItem = ClaudeAutocompleteItem;
export type AgentSubagentHistoryPayload = ClaudeSubagentHistoryPayload;
export type AgentMcpSnapshot = ClaudeMcpSnapshot;
export type AgentMcpAuthStartResult = ClaudeMcpAuthStartResult;

export type AgentImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface AgentImageInput {
  mediaType: AgentImageMediaType;
  data: string;
}
