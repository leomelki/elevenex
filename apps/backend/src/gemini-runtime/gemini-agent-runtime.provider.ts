import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'events';
import type {
  AgentAuthStatus,
  AgentForkConversationRequest,
  AgentImageInput,
  AgentLoginMode,
  AgentLoginStartResult,
  AgentRuntimeEvent,
  AgentRuntimeProvider,
  AgentRuntimeProviderInfo,
} from '../agent-runtime/agent-runtime.types.js';
import { GeminiAuthService } from './gemini-auth.service.js';
import { GeminiRuntimeService } from './gemini-runtime.service.js';

@Injectable()
export class GeminiAgentRuntimeProvider
  extends EventEmitter
  implements AgentRuntimeProvider, OnModuleInit
{
  readonly info: AgentRuntimeProviderInfo = {
    id: 'gemini',
    displayName: 'Gemini CLI',
    capabilities: {
      mcp: true,
      // Gemini has no subagent concept over ACP: nested agents, when it runs
      // them, are not reported as separate transcripts.
      subagents: false,
      permissions: true,
      // ACP has no elicitation/question channel distinct from permissions.
      userInput: false,
      multimodalPrompts: true,
      // The terminal fallback is a Claude-specific tmux/PTY path (claude
      // binary, claude hooks, claude session resume) rather than a generic
      // "run this provider's TUI" surface.
      terminalFallback: false,
      rewindConversation: true,
    },
  };

  constructor(
    private readonly runtimeService: GeminiRuntimeService,
    private readonly authService: GeminiAuthService,
  ) {
    super();
  }

  onModuleInit(): void {
    this.runtimeService.on('event', (event: AgentRuntimeEvent) => {
      this.emit('event', event);
    });
    this.authService.on('status', (status: AgentAuthStatus) => {
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
    return this.runtimeService.getAutocompleteItems(sessionId);
  }

  getModelCatalog() {
    return Promise.resolve(this.runtimeService.getModelCatalog());
  }

  getAuthStatus() {
    return this.authService.getStatus();
  }

  startLogin(options: {
    mode: AgentLoginMode;
    apiKey?: string;
    oauthProvider?: string;
    apiKeyProvider?: string;
  }): Promise<AgentLoginStartResult> {
    return this.authService.startLogin(options);
  }

  cancelLogin(): Promise<AgentAuthStatus> {
    return this.authService.cancelLogin();
  }

  continueLogin(): Promise<AgentAuthStatus> {
    return this.authService.continueLogin();
  }

  setSelectedModel(sessionId: number, model: string | null) {
    return this.runtimeService.setSelectedModel(sessionId, model);
  }

  setPermissionMode(sessionId: number, mode: string | null) {
    return this.runtimeService.setPermissionMode(sessionId, mode);
  }

  setPlanMode(sessionId: number, enabled: boolean) {
    return this.runtimeService.setPlanMode(sessionId, enabled);
  }

  setReasoningEffort(sessionId: number, effort: string | null) {
    return this.runtimeService.setReasoningEffort(sessionId, effort);
  }

  setFastMode(sessionId: number, enabled: boolean) {
    return this.runtimeService.setFastMode(sessionId, enabled);
  }

  getMcpSnapshot(sessionId: number) {
    return this.runtimeService.getMcpSnapshot(sessionId);
  }

  toggleMcpServer(sessionId: number, serverName: string) {
    return this.runtimeService.toggleMcpServer(sessionId, serverName);
  }

  /** Gemini owns its MCP connections, so a re-check is just a config re-read. */
  recheckMcpServer(sessionId: number) {
    return this.runtimeService.recheckMcpServer(sessionId);
  }

  forkConversation(request: AgentForkConversationRequest) {
    return this.runtimeService.forkConversation(request);
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

  cancelPendingPrompt(sessionId: number, id: string) {
    return this.runtimeService.cancelPendingPrompt(sessionId, id);
  }

  approvePermission(sessionId: number, requestId: string, remember?: boolean) {
    return this.runtimeService.approvePermission(
      sessionId,
      requestId,
      remember,
    );
  }

  denyPermission(sessionId: number, requestId: string) {
    return this.runtimeService.denyPermission(sessionId, requestId);
  }

  cleanupSession(sessionId: number) {
    return this.runtimeService.cleanupSession(sessionId);
  }

  onClientAttached(sessionId: number) {
    this.runtimeService.onClientAttached(sessionId);
  }

  onClientDetached(sessionId: number) {
    this.runtimeService.onClientDetached(sessionId);
  }
}
