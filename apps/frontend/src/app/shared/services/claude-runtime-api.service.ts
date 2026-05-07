import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { AgentRuntimeApiService } from './agent-runtime-api.service';
import type {
  ClaudeAutocompleteItem,
  ClaudeMcpAuthStartResult,
  ClaudeMcpSnapshot,
  ClaudeRuntimeState,
  ClaudeSubagentHistoryPayload,
  ClaudeTranscriptItem,
} from '../models/claude-runtime.model';

@Injectable({ providedIn: 'root' })
export class ClaudeRuntimeApiService {
  private readonly agentRuntimeApi = inject(AgentRuntimeApiService);

  getHistory(sessionId: number) {
    return this.agentRuntimeApi.getHistory(sessionId, 'claude') as Observable<
      ClaudeTranscriptItem[]
    >;
  }

  getRuntimeState(sessionId: number) {
    return this.agentRuntimeApi.getRuntimeState(
      sessionId,
      'claude',
    ) as Observable<ClaudeRuntimeState>;
  }

  getSubagentHistory(sessionId: number, agentId: string) {
    return this.agentRuntimeApi.getSubagentHistory(
      sessionId,
      agentId,
      'claude',
    ) as Observable<ClaudeSubagentHistoryPayload>;
  }

  getAutocompleteItems(sessionId: number) {
    return this.agentRuntimeApi.getAutocompleteItems(sessionId, 'claude') as Observable<
      ClaudeAutocompleteItem[]
    >;
  }

  getMcpSnapshot(sessionId: number, forceRefresh = false) {
    return this.agentRuntimeApi.getMcpSnapshot(
      sessionId,
      forceRefresh,
      'claude',
    ) as Observable<ClaudeMcpSnapshot>;
  }

  toggleMcpServer(sessionId: number, serverName: string) {
    return this.agentRuntimeApi.toggleMcpServer(
      sessionId,
      serverName,
      'claude',
    ) as Observable<ClaudeMcpSnapshot>;
  }

  recheckMcpServer(sessionId: number, serverName: string) {
    return this.agentRuntimeApi.recheckMcpServer(
      sessionId,
      serverName,
      'claude',
    ) as Observable<ClaudeMcpSnapshot>;
  }

  startMcpAuth(sessionId: number, serverName: string) {
    return this.agentRuntimeApi.startMcpAuth(
      sessionId,
      serverName,
      'claude',
    ) as Observable<ClaudeMcpAuthStartResult>;
  }

  setSelectedModel(sessionId: number, model: string | null) {
    return this.agentRuntimeApi.setSelectedModel(
      sessionId,
      model,
      'claude',
    ) as Observable<ClaudeRuntimeState>;
  }

  setPermissionMode(sessionId: number, mode: string | null) {
    return this.agentRuntimeApi.setPermissionMode(
      sessionId,
      mode,
      'claude',
    ) as Observable<ClaudeRuntimeState>;
  }

  openTerminalFallback(sessionId: number) {
    return this.agentRuntimeApi.openTerminalFallback(sessionId, 'claude');
  }

  rewindConversation(sessionId: number, messageId: string) {
    return this.agentRuntimeApi.rewindConversation(sessionId, messageId, 'claude') as Observable<
      ClaudeTranscriptItem[]
    >;
  }
}
