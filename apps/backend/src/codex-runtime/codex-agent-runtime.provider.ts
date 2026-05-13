import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'events';
import { CodexMcpService } from './codex-mcp.service.js';
import { CodexRuntimeService } from './codex-runtime.service.js';
import { CodexAuthService } from './codex-auth.service.js';
import type {
  CodexAuthStatus,
  CodexLoginMode,
  CodexLoginStartResult,
} from './codex-runtime.types.js';
import type {
  AgentPermissionMode,
  AgentImageInput,
  AgentRuntimeEvent,
  AgentRuntimeProvider,
  AgentRuntimeProviderInfo,
} from '../agent-runtime/agent-runtime.types.js';

@Injectable()
export class CodexAgentRuntimeProvider
  extends EventEmitter
  implements AgentRuntimeProvider, OnModuleInit
{
  readonly info: AgentRuntimeProviderInfo = {
    id: 'codex',
    displayName: 'OpenAI Codex',
    capabilities: {
      mcp: true,
      subagents: false,
      permissions: true,
      userInput: true,
      multimodalPrompts: true,
      terminalFallback: false,
      rewindConversation: false,
    },
  };

  constructor(
    private readonly runtimeService: CodexRuntimeService,
    private readonly mcpService: CodexMcpService,
    private readonly authService: CodexAuthService,
  ) {
    super();
  }

  onModuleInit(): void {
    this.runtimeService.on('event', (event: AgentRuntimeEvent) => {
      this.emit('event', event);
    });
    this.authService.on('status', (status: CodexAuthStatus) => {
      this.emit('auth_status', status);
    });
  }

  getHistory(sessionId: number) {
    return this.runtimeService.getHistory(sessionId);
  }

  getRuntimeState(sessionId: number) {
    return this.runtimeService.getRuntimeState(sessionId);
  }

  getSnapshot(sessionId: number) {
    return this.runtimeService.getSnapshot(sessionId);
  }

  getAutocompleteItems(sessionId: number) {
    void sessionId;
    return this.runtimeService.getAutocompleteItems();
  }

  onClientAttached(sessionId: number): void {
    void this.runtimeService.prewarmSession(sessionId);
  }

  getAuthStatus() {
    return this.authService.getStatus();
  }

  startLogin(
    options: { mode: CodexLoginMode; apiKey?: string } = { mode: 'oauth' },
  ): Promise<CodexLoginStartResult> {
    return this.authService.startLogin(options);
  }

  cancelLogin(): Promise<CodexAuthStatus> {
    return this.authService.cancelLogin();
  }

  getMcpSnapshot(sessionId: number) {
    return this.mcpService.getSnapshot(sessionId);
  }

  toggleMcpServer(sessionId: number, serverName: string) {
    return this.mcpService.toggleServer(sessionId, serverName);
  }

  recheckMcpServer(sessionId: number, serverName: string) {
    return this.mcpService.recheckServer(sessionId, serverName);
  }

  startMcpAuth(sessionId: number, serverName: string) {
    void sessionId;
    void serverName;
    return this.mcpService.startAuth();
  }

  setSelectedModel(sessionId: number, model: string | null) {
    return this.runtimeService.setSelectedModel(sessionId, model);
  }

  setPermissionMode(sessionId: number, mode: AgentPermissionMode | null) {
    return this.runtimeService.setPermissionMode(sessionId, mode);
  }

  submitPrompt(
    sessionId: number,
    prompt: string,
    titlePrompt?: string,
    images?: AgentImageInput[],
  ) {
    return this.runtimeService.submitPrompt(sessionId, prompt, titlePrompt, images);
  }

  interrupt(sessionId: number) {
    return this.runtimeService.interrupt(sessionId);
  }

  cancelPendingPrompt(sessionId: number, id: string) {
    return this.runtimeService.cancelPendingPrompt(sessionId, id);
  }

  approvePermission(
    sessionId: number,
    requestId: string,
    remember?: boolean,
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
    action?: 'accept' | 'decline' | 'cancel',
    content?: Record<string, string | number | boolean | string[]>,
  ) {
    return this.runtimeService.answerUserInput(
      sessionId,
      requestId,
      action,
      content,
    );
  }

  cleanupSession(sessionId: number) {
    return this.runtimeService.cleanupSession(sessionId);
  }
}
