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
import type { AgentProviderId } from '../models/agent-runtime.model';

@Injectable({ providedIn: 'root' })
export class ClaudeRuntimeApiService {
  private readonly agentRuntimeApi = inject(AgentRuntimeApiService);
  private readonly providerSelection = inject(AgentRuntimeProviderService);
  private readonly sessionProviders = new Map<number, AgentProviderId>();

  setProvider(sessionId: number, provider: AgentProviderId): void {
    this.sessionProviders.set(sessionId, provider);
  }

  clearProvider(sessionId: number): void {
    this.sessionProviders.delete(sessionId);
  }

  getHistory(sessionId: number) {
    return this.agentRuntimeApi.getHistory(sessionId, this.provider(sessionId)) as Observable<
      ClaudeTranscriptItem[]
    >;
  }

  getRuntimeState(sessionId: number) {
    return this.agentRuntimeApi.getRuntimeState(
      sessionId,
      this.provider(sessionId),
    ) as Observable<ClaudeRuntimeState>;
  }

  getSubagentHistory(sessionId: number, agentId: string) {
    return this.agentRuntimeApi.getSubagentHistory(
      sessionId,
      agentId,
      this.provider(sessionId),
    ) as Observable<ClaudeSubagentHistoryPayload>;
  }

  getAutocompleteItems(sessionId: number) {
    return this.agentRuntimeApi.getAutocompleteItems(
      sessionId,
      this.provider(sessionId),
    ) as Observable<ClaudeAutocompleteItem[]>;
  }

  getMcpSnapshot(sessionId: number, forceRefresh = false) {
    return this.agentRuntimeApi.getMcpSnapshot(
      sessionId,
      forceRefresh,
      this.provider(sessionId),
    ) as Observable<ClaudeMcpSnapshot>;
  }

  toggleMcpServer(sessionId: number, serverName: string) {
    return this.agentRuntimeApi.toggleMcpServer(
      sessionId,
      serverName,
      this.provider(sessionId),
    ) as Observable<ClaudeMcpSnapshot>;
  }

  recheckMcpServer(sessionId: number, serverName: string) {
    return this.agentRuntimeApi.recheckMcpServer(
      sessionId,
      serverName,
      this.provider(sessionId),
    ) as Observable<ClaudeMcpSnapshot>;
  }

  startMcpAuth(sessionId: number, serverName: string) {
    return this.agentRuntimeApi.startMcpAuth(
      sessionId,
      serverName,
      this.provider(sessionId),
    ) as Observable<ClaudeMcpAuthStartResult>;
  }

  setSelectedModel(sessionId: number, model: string | null) {
    return this.agentRuntimeApi.setSelectedModel(
      sessionId,
      model,
      this.provider(sessionId),
    ) as Observable<ClaudeRuntimeState>;
  }

  setPermissionMode(sessionId: number, mode: string | null) {
    return this.agentRuntimeApi.setPermissionMode(
      sessionId,
      mode,
      this.provider(sessionId),
    ) as Observable<ClaudeRuntimeState>;
  }

  setPlanMode(sessionId: number, enabled: boolean) {
    return this.agentRuntimeApi.setPlanMode(
      sessionId,
      enabled,
      this.provider(sessionId),
    ) as Observable<ClaudeRuntimeState>;
  }

  setReasoningEffort(sessionId: number, effort: string | null) {
    return this.agentRuntimeApi.setReasoningEffort(
      sessionId,
      effort,
      this.provider(sessionId),
    ) as Observable<ClaudeRuntimeState>;
  }

  setFastMode(sessionId: number, enabled: boolean) {
    return this.agentRuntimeApi.setFastMode(
      sessionId,
      enabled,
      this.provider(sessionId),
    ) as Observable<ClaudeRuntimeState>;
  }

  openTerminalFallback(sessionId: number) {
    return this.agentRuntimeApi.openTerminalFallback(sessionId, this.provider(sessionId));
  }

  rewindConversation(sessionId: number, messageId: string) {
    return this.agentRuntimeApi.rewindConversation(
      sessionId,
      messageId,
      this.provider(sessionId),
    ) as Observable<ClaudeTranscriptItem[]>;
  }

  private provider(sessionId: number): AgentProviderId {
    return this.sessionProviders.get(sessionId) ?? this.providerSelection.currentProvider;
  }
}
