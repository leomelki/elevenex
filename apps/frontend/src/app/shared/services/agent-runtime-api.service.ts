import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  AgentAuthStatus,
  AgentAutocompleteItem,
  AgentLoginMode,
  AgentLoginStartResult,
  AgentMcpAuthStartResult,
  AgentMcpSnapshot,
  AgentProviderId,
  AgentRuntimeProviderInfo,
  AgentRuntimeState,
  AgentSubagentHistoryPayload,
  AgentTranscriptItem,
} from '../models/agent-runtime.model';
import { AgentRuntimeProviderService } from './agent-runtime-provider.service';

@Injectable({ providedIn: 'root' })
export class AgentRuntimeApiService {
  private readonly http = inject(HttpClient);
  private readonly providerSelection = inject(AgentRuntimeProviderService);

  listProviders() {
    return this.http.get<AgentRuntimeProviderInfo[]>('/api/agent-providers');
  }

  getAuthStatus(provider = this.currentProvider()) {
    return this.http.get<AgentAuthStatus>(
      `/api/agent-providers/${encodeURIComponent(provider)}/auth/status`,
    );
  }

  startLogin(
    body: { mode: AgentLoginMode; apiKey?: string; oauthProvider?: string; apiKeyProvider?: string },
    provider = this.currentProvider(),
  ) {
    return this.http.post<AgentLoginStartResult>(
      `/api/agent-providers/${encodeURIComponent(provider)}/auth/login`,
      body,
    );
  }

  cancelLogin(provider = this.currentProvider()) {
    return this.http.post<AgentAuthStatus>(
      `/api/agent-providers/${encodeURIComponent(provider)}/auth/cancel-login`,
      {},
    );
  }

  continueLogin(body: { code: string }, provider = this.currentProvider()) {
    return this.http.post<AgentAuthStatus>(
      `/api/agent-providers/${encodeURIComponent(provider)}/auth/continue-login`,
      body,
    );
  }

  getHistory(sessionId: number, provider = this.currentProvider()) {
    return this.http.get<AgentTranscriptItem[]>(`${this.basePath(sessionId, provider)}/history`);
  }

  getRuntimeState(sessionId: number, provider = this.currentProvider()) {
    return this.http.get<AgentRuntimeState>(`${this.basePath(sessionId, provider)}/runtime-state`);
  }

  getSubagentHistory(sessionId: number, agentId: string, provider = this.currentProvider()) {
    return this.http.get<AgentSubagentHistoryPayload>(
      `${this.basePath(sessionId, provider)}/subagents/${encodeURIComponent(agentId)}/history`,
    );
  }

  getAutocompleteItems(sessionId: number, provider = this.currentProvider()) {
    return this.http.get<AgentAutocompleteItem[]>(
      `${this.basePath(sessionId, provider)}/autocomplete`,
    );
  }

  getMcpSnapshot(sessionId: number, forceRefresh = false, provider = this.currentProvider()) {
    return this.http.get<AgentMcpSnapshot>(`${this.basePath(sessionId, provider)}/mcp`, {
      params: forceRefresh ? { forceRefresh: '1' } : undefined,
    });
  }

  toggleMcpServer(sessionId: number, serverName: string, provider = this.currentProvider()) {
    return this.http.post<AgentMcpSnapshot>(
      `${this.basePath(sessionId, provider)}/mcp/${encodeURIComponent(serverName)}/toggle`,
      {},
    );
  }

  recheckMcpServer(sessionId: number, serverName: string, provider = this.currentProvider()) {
    return this.http.post<AgentMcpSnapshot>(
      `${this.basePath(sessionId, provider)}/mcp/${encodeURIComponent(serverName)}/recheck`,
      {},
    );
  }

  startMcpAuth(sessionId: number, serverName: string, provider = this.currentProvider()) {
    return this.http.post<AgentMcpAuthStartResult>(
      `${this.basePath(sessionId, provider)}/mcp/${encodeURIComponent(serverName)}/auth/start`,
      {},
    );
  }

  setSelectedModel(sessionId: number, model: string | null, provider = this.currentProvider()) {
    return this.http.post<AgentRuntimeState>(`${this.basePath(sessionId, provider)}/model`, {
      model,
    });
  }

  setPermissionMode(sessionId: number, mode: string | null, provider = this.currentProvider()) {
    return this.http.post<AgentRuntimeState>(
      `${this.basePath(sessionId, provider)}/permission-mode`,
      { mode },
    );
  }

  openTerminalFallback(sessionId: number, provider = this.currentProvider()) {
    return this.http.post(`${this.basePath(sessionId, provider)}/terminal-fallback`, {});
  }

  rewindConversation(sessionId: number, messageId: string, provider = this.currentProvider()) {
    return this.http.post<AgentTranscriptItem[]>(
      `${this.basePath(sessionId, provider)}/rewind-conversation`,
      { messageId },
    );
  }

  private currentProvider(): AgentProviderId {
    return this.providerSelection.currentProvider;
  }

  private basePath(sessionId: number, provider: AgentProviderId): string {
    return `/api/sessions/${sessionId}/agents/${encodeURIComponent(provider)}`;
  }
}
