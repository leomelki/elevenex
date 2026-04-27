import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  ClaudeAutocompleteItem,
  ClaudeMcpAuthStartResult,
  ClaudeMcpSnapshot,
  ClaudeSubagentHistoryPayload,
  ClaudeRuntimeState,
  ClaudeTranscriptItem,
} from '../models/claude-runtime.model';

@Injectable({ providedIn: 'root' })
export class ClaudeRuntimeApiService {
  private readonly http = inject(HttpClient);

  getHistory(sessionId: number) {
    return this.http.get<ClaudeTranscriptItem[]>(`/api/sessions/${sessionId}/claude/history`);
  }

  getRuntimeState(sessionId: number) {
    return this.http.get<ClaudeRuntimeState>(`/api/sessions/${sessionId}/claude/runtime-state`);
  }

  getSubagentHistory(sessionId: number, agentId: string) {
    return this.http.get<ClaudeSubagentHistoryPayload>(
      `/api/sessions/${sessionId}/claude/subagents/${encodeURIComponent(agentId)}/history`,
    );
  }

  getAutocompleteItems(sessionId: number) {
    return this.http.get<ClaudeAutocompleteItem[]>(`/api/sessions/${sessionId}/claude/autocomplete`);
  }

  getMcpSnapshot(sessionId: number, forceRefresh = false) {
    return this.http.get<ClaudeMcpSnapshot>(`/api/sessions/${sessionId}/claude/mcp`, {
      params: forceRefresh ? { forceRefresh: '1' } : undefined,
    });
  }

  toggleMcpServer(sessionId: number, serverName: string) {
    return this.http.post<ClaudeMcpSnapshot>(
      `/api/sessions/${sessionId}/claude/mcp/${encodeURIComponent(serverName)}/toggle`,
      {},
    );
  }

  recheckMcpServer(sessionId: number, serverName: string) {
    return this.http.post<ClaudeMcpSnapshot>(
      `/api/sessions/${sessionId}/claude/mcp/${encodeURIComponent(serverName)}/recheck`,
      {},
    );
  }

  startMcpAuth(sessionId: number, serverName: string) {
    return this.http.post<ClaudeMcpAuthStartResult>(
      `/api/sessions/${sessionId}/claude/mcp/${encodeURIComponent(serverName)}/auth/start`,
      {},
    );
  }

  setSelectedModel(sessionId: number, model: string | null) {
    return this.http.post<ClaudeRuntimeState>(`/api/sessions/${sessionId}/claude/model`, { model });
  }

  setPermissionMode(sessionId: number, mode: string | null) {
    return this.http.post<ClaudeRuntimeState>(`/api/sessions/${sessionId}/claude/permission-mode`, {
      mode,
    });
  }

  openTerminalFallback(sessionId: number) {
    return this.http.post(`/api/sessions/${sessionId}/claude/terminal-fallback`, {});
  }

  rewindConversation(sessionId: number, messageId: string) {
    return this.http.post<ClaudeTranscriptItem[]>(
      `/api/sessions/${sessionId}/claude/rewind-conversation`,
      { messageId },
    );
  }
}
