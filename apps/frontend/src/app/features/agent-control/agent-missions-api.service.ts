import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

import { AgentAutonomyMode, MissionSummary } from './agent-control.model';

/**
 * Thin HttpClient wrapper for the backend missions API (`/api/agent/missions`).
 * A mission is a hidden `surface:'agent'` session; this service never touches
 * runtime/session state directly — it just talks to the missions controller.
 */
@Injectable({ providedIn: 'root' })
export class AgentMissionsApiService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/agent/missions';

  create(body: {
    prompt: string;
    autonomyMode?: AgentAutonomyMode;
    model?: string;
    focusedSessionId?: number;
  }): Observable<MissionSummary> {
    return this.http.post<MissionSummary>(this.base, body);
  }

  list(): Observable<MissionSummary[]> {
    return this.http.get<MissionSummary[]>(this.base);
  }

  get(sessionId: number): Observable<MissionSummary> {
    return this.http.get<MissionSummary>(`${this.base}/${sessionId}`);
  }

  setAutonomy(
    sessionId: number,
    autonomyMode: AgentAutonomyMode,
  ): Observable<MissionSummary> {
    return this.http.post<MissionSummary>(`${this.base}/${sessionId}/autonomy`, {
      autonomyMode,
    });
  }

  interrupt(sessionId: number): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(
      `${this.base}/${sessionId}/interrupt`,
      {},
    );
  }

  archive(sessionId: number): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(
      `${this.base}/${sessionId}/archive`,
      {},
    );
  }
}
