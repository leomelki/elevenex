import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'events';
import type {
  AgentAuthStatus,
  AgentImageInput,
  AgentRuntimeEvent,
  AgentRuntimeProvider,
  AgentRuntimeProviderInfo,
} from '../agent-runtime/agent-runtime.types.js';
import { AntigravityAuthService } from './antigravity-auth.service.js';
import { AntigravityRuntimeService } from './antigravity-runtime.service.js';

@Injectable()
export class AntigravityAgentRuntimeProvider
  extends EventEmitter
  implements AgentRuntimeProvider, OnModuleInit
{
  readonly info: AgentRuntimeProviderInfo = {
    id: 'antigravity',
    displayName: 'Antigravity CLI',
    capabilities: {
      mcp: true,
      // `agy` reports no separate subagent transcripts over its stream
      // protocol.
      subagents: false,
      // `agy`'s headless stream has no documented bidirectional permission
      // channel — see the "Permission model" note in
      // docs/antigravity-provider-flow.md. Permission posture is chosen at
      // spawn time via flags instead of a live approve/deny UI.
      permissions: false,
      userInput: false,
      // No confirmed image content-block shape in the stream protocol yet.
      multimodalPrompts: false,
      terminalFallback: false,
      // No confirmed on-disk conversation format to truncate/replay.
      rewindConversation: false,
    },
  };

  constructor(
    private readonly runtimeService: AntigravityRuntimeService,
    private readonly authService: AntigravityAuthService,
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
    mode: 'oauth' | 'api_key';
    apiKey?: string;
    oauthProvider?: string;
    apiKeyProvider?: string;
  }) {
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

  recheckMcpServer(sessionId: number) {
    return this.runtimeService.recheckMcpServer(sessionId);
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
