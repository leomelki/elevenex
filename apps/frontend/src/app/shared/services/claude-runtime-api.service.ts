import { inject, Injectable } from '@angular/core';
import { AgentRuntimeApiService } from './agent-runtime-api.service';

@Injectable({ providedIn: 'root' })
export class ClaudeRuntimeApiService {
  private readonly agentRuntimeApi = inject(AgentRuntimeApiService);

  getHistory(sessionId: number) {
    return this.agentRuntimeApi.getHistory(sessionId, 'claude');
  }

  getRuntimeState(sessionId: number) {
    return this.agentRuntimeApi.getRuntimeState(sessionId, 'claude');
  }

  getSubagentHistory(sessionId: number, agentId: string) {
    return this.agentRuntimeApi.getSubagentHistory(sessionId, agentId, 'claude');
  }

  getAutocompleteItems(sessionId: number) {
    return this.agentRuntimeApi.getAutocompleteItems(sessionId, 'claude');
  }

  getMcpSnapshot(sessionId: number, forceRefresh = false) {
    return this.agentRuntimeApi.getMcpSnapshot(sessionId, forceRefresh, 'claude');
  }

  toggleMcpServer(sessionId: number, serverName: string) {
    return this.agentRuntimeApi.toggleMcpServer(sessionId, serverName, 'claude');
  }

  recheckMcpServer(sessionId: number, serverName: string) {
    return this.agentRuntimeApi.recheckMcpServer(sessionId, serverName, 'claude');
  }

  startMcpAuth(sessionId: number, serverName: string) {
    return this.agentRuntimeApi.startMcpAuth(sessionId, serverName, 'claude');
  }

  setSelectedModel(sessionId: number, model: string | null) {
    return this.agentRuntimeApi.setSelectedModel(sessionId, model, 'claude');
  }

  setPermissionMode(sessionId: number, mode: string | null) {
    return this.agentRuntimeApi.setPermissionMode(sessionId, mode, 'claude');
  }

  openTerminalFallback(sessionId: number) {
    return this.agentRuntimeApi.openTerminalFallback(sessionId, 'claude');
  }

  rewindConversation(sessionId: number, messageId: string) {
    return this.agentRuntimeApi.rewindConversation(sessionId, messageId, 'claude');
  }
}
