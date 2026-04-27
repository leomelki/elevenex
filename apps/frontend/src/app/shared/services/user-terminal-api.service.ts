import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

export interface UserTerminal {
  id: number;
  worktreePath: string;
  name: string;
  shell: string;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class UserTerminalApiService {
  private http = inject(HttpClient);

  create(worktreePath: string, name?: string) {
    return this.http.post<UserTerminal>('/api/user-terminals', { worktreePath, name });
  }

  listByWorktree(worktreePath: string) {
    return this.http.get<UserTerminal[]>('/api/user-terminals', {
      params: { worktreePath },
    });
  }

  findOne(id: number) {
    return this.http.get<UserTerminal>(`/api/user-terminals/${id}`);
  }

  rename(id: number, name: string) {
    return this.http.patch<UserTerminal>(`/api/user-terminals/${id}`, { name });
  }

  remove(id: number) {
    return this.http.delete<{ success: boolean }>(`/api/user-terminals/${id}`);
  }
}
