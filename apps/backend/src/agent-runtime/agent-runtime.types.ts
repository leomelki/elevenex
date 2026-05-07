import { EventEmitter } from 'events';
import type {
  ClaudeAutocompleteItem,
  ClaudeImageInput,
  ClaudeMcpAuthStartResult,
  ClaudeMcpSnapshot,
  ClaudePermissionMode,
  ClaudeRuntimeEvent,
  ClaudeRuntimeStatePayload,
  ClaudeSessionSnapshotPayload,
  ClaudeSubagentHistoryPayload,
  ClaudeTranscriptItem,
} from '../claude-runtime/claude-runtime.types.js';

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

export type AgentRuntimeStatePayload = ClaudeRuntimeStatePayload;
export type AgentSessionSnapshotPayload = ClaudeSessionSnapshotPayload;
export type AgentTranscriptItem = ClaudeTranscriptItem;
export type AgentAutocompleteItem = ClaudeAutocompleteItem;
export type AgentRuntimeEvent = ClaudeRuntimeEvent;
export type AgentSubagentHistoryPayload = ClaudeSubagentHistoryPayload;
export type AgentMcpSnapshot = ClaudeMcpSnapshot;
export type AgentMcpAuthStartResult = ClaudeMcpAuthStartResult;
export type AgentPermissionMode = ClaudePermissionMode;
export type AgentImageInput = ClaudeImageInput;

export interface AgentRuntimeProvider extends EventEmitter {
  readonly info: AgentRuntimeProviderInfo;

  getHistory(sessionId: number): Promise<AgentTranscriptItem[]>;
  getRuntimeState(sessionId: number): Promise<AgentRuntimeStatePayload>;
  getSubagentHistory(
    sessionId: number,
    agentId: string,
  ): Promise<AgentSubagentHistoryPayload>;
  getSnapshot(sessionId: number): Promise<AgentSessionSnapshotPayload>;
  getAutocompleteItems(sessionId: number): Promise<AgentAutocompleteItem[]>;

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

  setSelectedModel(
    sessionId: number,
    model: string | null,
  ): Promise<AgentRuntimeStatePayload>;
  setPermissionMode(
    sessionId: number,
    mode: AgentPermissionMode | null,
  ): Promise<AgentRuntimeStatePayload>;

  openTerminalFallback(sessionId: number): Promise<unknown>;
  rewindConversation(
    sessionId: number,
    messageId: string,
  ): Promise<AgentTranscriptItem[]>;

  submitPrompt(
    sessionId: number,
    prompt: string,
    titlePrompt?: string,
    images?: AgentImageInput[],
  ): Promise<void>;
  interrupt(sessionId: number): Promise<void>;
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
  cancelPendingPrompt(sessionId: number, id: string): Promise<void>;
  cleanupSession(sessionId: number): Promise<void>;
}

export interface AgentRuntimeCleanup {
  cleanupSession(sessionId: number): Promise<void>;
}
