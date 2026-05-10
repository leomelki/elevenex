import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { AgentRuntimeApiService } from './agent-runtime-api.service';
import { AgentRuntimeProviderService } from './agent-runtime-provider.service';
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
  private readonly providerSelection = inject(AgentRuntimeProviderService);

  getHistory(sessionId: number) {
    return this.agentRuntimeApi.getHistory(sessionId, this.provider()) as Observable<
      ClaudeTranscriptItem[]
    >;
  }

  getRuntimeState(sessionId: number) {
    return this.agentRuntimeApi.getRuntimeState(
      sessionId,
      this.provider(),
    ) as Observable<ClaudeRuntimeState>;
  }

  getSubagentHistory(sessionId: number, agentId: string) {
    return this.agentRuntimeApi.getSubagentHistory(
      sessionId,
      agentId,
      this.provider(),
    ) as Observable<ClaudeSubagentHistoryPayload>;
  }

  getAutocompleteItems(sessionId: number) {
    return this.agentRuntimeApi.getAutocompleteItems(sessionId, this.provider()) as Observable<
      ClaudeAutocompleteItem[]
    >;
  }

  getMcpSnapshot(sessionId: number, forceRefresh = false) {
    return this.agentRuntimeApi.getMcpSnapshot(
      sessionId,
      forceRefresh,
      this.provider(),
    ) as Observable<ClaudeMcpSnapshot>;
  }

  toggleMcpServer(sessionId: number, serverName: string) {
    return this.agentRuntimeApi.toggleMcpServer(
      sessionId,
      serverName,
      this.provider(),
    ) as Observable<ClaudeMcpSnapshot>;
  }

  recheckMcpServer(sessionId: number, serverName: string) {
    return this.agentRuntimeApi.recheckMcpServer(
      sessionId,
      serverName,
      this.provider(),
    ) as Observable<ClaudeMcpSnapshot>;
  }

  startMcpAuth(sessionId: number, serverName: string) {
    return this.agentRuntimeApi.startMcpAuth(
      sessionId,
      serverName,
      this.provider(),
    ) as Observable<ClaudeMcpAuthStartResult>;
  }

  setSelectedModel(sessionId: number, model: string | null) {
    return this.agentRuntimeApi.setSelectedModel(
      sessionId,
      model,
      this.provider(),
    ) as Observable<ClaudeRuntimeState>;
  }

  setPermissionMode(sessionId: number, mode: string | null) {
    return this.agentRuntimeApi.setPermissionMode(
      sessionId,
      mode,
      this.provider(),
    ) as Observable<ClaudeRuntimeState>;
  }

  openTerminalFallback(sessionId: number) {
    return this.agentRuntimeApi.openTerminalFallback(sessionId, this.provider());
  }

  rewindConversation(sessionId: number, messageId: string) {
    return this.agentRuntimeApi.rewindConversation(sessionId, messageId, this.provider()) as Observable<
      ClaudeTranscriptItem[]
    >;
  }

  private provider() {
    return this.providerSelection.currentProvider;
  }
}
