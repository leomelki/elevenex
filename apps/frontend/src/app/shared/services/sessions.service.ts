import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Session } from '../models/session.model';

@Injectable({ providedIn: 'root' })
export class SessionsService {
  private http = inject(HttpClient);

  getByRepo(repoId: number) {
    return this.http.get<Session[]>(`/api/sessions/repo/${repoId}`);
  }

  getOne(id: number) {
    return this.http.get<Session>(`/api/sessions/${id}`);
  }

  markReviewed(id: number) {
    return this.http.post<Session>(`/api/sessions/${id}/mark-reviewed`, {});
  }

  create(data: { repoId: number; branchName: string; worktreePath: string; name?: string }) {
    return this.http.post<Session>('/api/sessions', data);
  }

  update(id: number, data: { name?: string }) {
    return this.http.patch<Session>(`/api/sessions/${id}`, data);
  }

  updateStatus(id: number, status: string) {
    return this.http.patch<Session>(`/api/sessions/${id}/status`, { status });
  }

  delete(id: number) {
    return this.http.delete<Session>(`/api/sessions/${id}`);
  }

  archive(id: number) {
    return this.http.post<Session>(`/api/sessions/${id}/archive`, {});
  }

  reset(id: number) {
    return this.http.post<Session>(`/api/sessions/${id}/reset`, {});
  }

  fork(id: number, name?: string) {
    return this.http.post<Session>(`/api/sessions/${id}/fork`, { name });
  }

  kill(id: number) {
    return this.http.post<Session>(`/api/sessions/${id}/kill`, {});
  }
}
