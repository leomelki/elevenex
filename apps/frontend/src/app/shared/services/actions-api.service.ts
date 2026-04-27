import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Action } from '../models/action.model';

@Injectable({ providedIn: 'root' })
export class ActionsApiService {
  private http = inject(HttpClient);

  listByWorktree(worktreePath: string) {
    return this.http.get<Action[]>('/api/actions', {
      params: { worktreePath },
    });
  }

  create(worktreePath: string, name: string, command: string) {
    return this.http.post<Action>('/api/actions', { worktreePath, name, command });
  }

  update(id: number, payload: { name?: string; command?: string }) {
    return this.http.patch<Action>(`/api/actions/${id}`, payload);
  }

  remove(id: number) {
    return this.http.delete<{ success: boolean }>(`/api/actions/${id}`);
  }

  run(id: number) {
    return this.http.post<Action>(`/api/actions/${id}/run`, {});
  }

  stop(id: number) {
    return this.http.post<{ success: boolean }>(`/api/actions/${id}/stop`, {});
  }
}
