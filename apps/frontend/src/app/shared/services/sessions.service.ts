import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  CreateSessionForkRequest,
  CreateSessionForkResponse,
  Session,
  SessionFork,
} from '../models/session.model';
import type { AgentProviderId } from '../models/agent-runtime.model';
import { of, tap } from 'rxjs';
import { getBackendOrigin } from '../runtime/runtime-config';

@Injectable({ providedIn: 'root' })
export class SessionsService {
  private http = inject(HttpClient);
  private readonly createdSessions = new Map<number, {
    session: Session;
    createdAt: number;
    origin: string;
  }>();

  getByRepo(repoId: number) {
    return this.http.get<Session[]>(`/api/sessions/repo/${repoId}`);
  }

  getOne(id: number) {
    const created = this.createdSessions.get(id);
    this.createdSessions.delete(id);
    // Consume once, only for the immediate creation-to-navigation handoff.
    if (created && created.origin === getBackendOrigin() && Date.now() - created.createdAt < 10_000)
      return of(created.session);
    return this.http.get<Session>(`/api/sessions/${id}`);
  }

  markReviewed(id: number) {
    return this.http.post<Session>(`/api/sessions/${id}/mark-reviewed`, {});
  }

  create(data: {
    repoId: number;
    workspaceId?: number;
    folderId?: number;
    branchName?: string;
    worktreePath?: string;
    name?: string;
    isTemporary?: boolean;
  }) {
    const origin = getBackendOrigin();
    return this.http.post<Session>('/api/sessions', data).pipe(
      tap((session) => {
        if (this.createdSessions.size >= 20)
          this.createdSessions.delete(this.createdSessions.keys().next().value!);
        this.createdSessions.set(session.id, { session, createdAt: Date.now(), origin });
      }),
    );
  }

  update(id: number, data: { name?: string }) {
    return this.http.patch<Session>(`/api/sessions/${id}`, data);
  }

  moveToFolder(id: number, folderId: number | null) {
    return this.http.patch<Session>(`/api/sessions/${id}/folder`, { folderId });
  }

  updateStatus(id: number, status: string) {
    return this.http.patch<Session>(`/api/sessions/${id}/status`, { status });
  }

  updateActiveAgentProvider(id: number, provider: AgentProviderId) {
    return this.http.patch<Session>(`/api/sessions/${id}/agent-provider`, { provider });
  }

  delete(id: number) {
    return this.http.delete<Session>(`/api/sessions/${id}`);
  }

  archive(id: number) {
    return this.http.post<Session>(`/api/sessions/${id}/archive`, {});
  }

  unarchive(id: number) {
    return this.http.post<Session>(`/api/sessions/${id}/unarchive`, {});
  }

  reset(id: number) {
    return this.http.post<Session>(`/api/sessions/${id}/reset`, {});
  }

  fork(id: number, name?: string) {
    return this.http.post<Session>(`/api/sessions/${id}/fork`, { name });
  }

  getForks(id: number) {
    return this.http.get<SessionFork[]>(`/api/sessions/${id}/forks`);
  }

  createFork(id: number, data: CreateSessionForkRequest) {
    return this.http.post<CreateSessionForkResponse>(`/api/sessions/${id}/forks`, data);
  }

  kill(id: number) {
    return this.http.post<Session>(`/api/sessions/${id}/kill`, {});
  }
}
