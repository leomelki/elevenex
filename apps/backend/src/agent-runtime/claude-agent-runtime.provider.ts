import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'events';
import { ClaudeMcpService } from '../claude-runtime/claude-mcp.service.js';
import { ClaudeRuntimeService } from '../claude-runtime/claude-runtime.service.js';
import type { ClaudePermissionMode } from '../claude-runtime/claude-runtime.types.js';
import type {
  AgentImageInput,
  AgentPermissionMode,
  AgentRuntimeEvent,
  AgentRuntimeProvider,
  AgentRuntimeProviderInfo,
} from './agent-runtime.types.js';

@Injectable()
export class ClaudeAgentRuntimeProvider
  extends EventEmitter
  implements AgentRuntimeProvider, OnModuleInit
{
  readonly info: AgentRuntimeProviderInfo = {
    id: 'claude',
    displayName: 'Claude Code',
    capabilities: {
      mcp: true,
      subagents: true,
      permissions: true,
      userInput: true,
      multimodalPrompts: true,
      terminalFallback: true,
      rewindConversation: true,
    },
  };

  constructor(
    private readonly runtimeService: ClaudeRuntimeService,
    private readonly mcpService: ClaudeMcpService,
  ) {
    super();
  }

  onModuleInit(): void {
    this.runtimeService.on('event', (event: AgentRuntimeEvent) => {
      this.emit('event', event);
    });
  }

  getHistory(sessionId: number) {
    return this.runtimeService.getHistory(sessionId);
  }

  getRuntimeState(sessionId: number) {
    return this.runtimeService.getRuntimeState(sessionId);
  }

  getSubagentHistory(sessionId: number, agentId: string) {
    return this.runtimeService.getSubagentHistory(sessionId, agentId);
  }

  getSnapshot(sessionId: number) {
    return this.runtimeService.getSnapshot(sessionId);
  }

  getAutocompleteItems(sessionId: number) {
    return this.runtimeService.getAutocompleteItems(sessionId);
  }

  getMcpSnapshot(sessionId: number, forceRefresh = false) {
    return this.mcpService.getSnapshot(sessionId, forceRefresh);
  }

  toggleMcpServer(sessionId: number, serverName: string) {
    return this.mcpService.toggleServer(sessionId, serverName);
  }

  recheckMcpServer(sessionId: number, serverName: string) {
    return this.mcpService.recheckServer(sessionId, serverName);
  }

  startMcpAuth(sessionId: number, serverName: string) {
    return this.mcpService.startAuth(sessionId, serverName);
  }

  setSelectedModel(sessionId: number, model: string | null) {
    return this.runtimeService.setSelectedModel(sessionId, model);
  }

  setPermissionMode(sessionId: number, mode: AgentPermissionMode | null) {
    return this.runtimeService.setPermissionMode(
      sessionId,
      mode as ClaudePermissionMode | null,
    );
  }

  openTerminalFallback(sessionId: number) {
    return this.runtimeService.openTerminalFallback(sessionId);
  }

  rewindConversation(sessionId: number, messageId: string) {
    return this.runtimeService.rewindConversation(sessionId, messageId);
  }

  submitPrompt(
    sessionId: number,
    prompt: string,
    titlePrompt?: string,
    images?: AgentImageInput[],
  ) {
    return this.runtimeService.submitPrompt(
      sessionId,
      prompt,
      titlePrompt,
      images,
    );
  }

  interrupt(sessionId: number) {
    return this.runtimeService.interrupt(sessionId);
  }

  approvePermission(
    sessionId: number,
    requestId: string,
    remember = false,
    content?: Record<string, unknown>,
  ) {
    return this.runtimeService.approvePermission(
      sessionId,
      requestId,
      remember,
      content,
    );
  }

  denyPermission(sessionId: number, requestId: string, message?: string) {
    return this.runtimeService.denyPermission(sessionId, requestId, message);
  }

  answerUserInput(
    sessionId: number,
    requestId: string,
    action: 'accept' | 'decline' | 'cancel' = 'accept',
    content?: Record<string, string | number | boolean | string[]>,
  ) {
    return this.runtimeService.answerUserInput(
      sessionId,
      requestId,
      action,
      content,
    );
  }

  cancelPendingPrompt(sessionId: number, id: string) {
    return this.runtimeService.cancelPendingPrompt(sessionId, id);
  }

  cleanupSession(sessionId: number) {
    return this.runtimeService.cleanupSession(sessionId);
  }
}
