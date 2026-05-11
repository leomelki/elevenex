import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'events';
import type {
  AgentAuthStatus,
  AgentImageInput,
  AgentLoginMode,
  AgentLoginStartResult,
  AgentRuntimeEvent,
  AgentRuntimeProvider,
  AgentRuntimeProviderInfo,
} from '../agent-runtime/agent-runtime.types.js';
import { PiAuthService } from './pi-auth.service.js';
import { PiRuntimeService } from './pi-runtime.service.js';

@Injectable()
export class PiAgentRuntimeProvider
  extends EventEmitter
  implements AgentRuntimeProvider, OnModuleInit
{
  readonly info: AgentRuntimeProviderInfo = {
    id: 'pi',
    displayName: 'Pi',
    capabilities: {
      mcp: false,
      subagents: false,
      permissions: false,
      userInput: true,
      multimodalPrompts: true,
      terminalFallback: false,
      rewindConversation: false,
    },
  };

  constructor(
    private readonly runtimeService: PiRuntimeService,
    private readonly authService: PiAuthService,
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

  continueLogin(options: { code: string }): Promise<AgentAuthStatus> {
    return this.authService.continueLogin(options);
  }

  setSelectedModel(sessionId: number, model: string | null) {
    return this.runtimeService.setSelectedModel(sessionId, model);
  }

  submitPrompt(
    sessionId: number,
    prompt: string,
    titlePrompt?: string,
    images?: AgentImageInput[],
  ) {
    void titlePrompt;
    return this.runtimeService.submitPrompt(sessionId, prompt, images);
  }

  interrupt(sessionId: number) {
    return this.runtimeService.interrupt(sessionId);
  }

  cancelPendingPrompt(sessionId: number, id: string) {
    return this.runtimeService.cancelPendingPrompt(sessionId, id);
  }

  answerUserInput(
    sessionId: number,
    requestId: string,
    action?: 'accept' | 'decline' | 'cancel',
    content?: Record<string, string | number | boolean | string[]>,
  ) {
    return this.runtimeService.answerUserInput(sessionId, requestId, action, content);
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
