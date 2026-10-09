import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Task, TaskSetup } from './task.model';
import { Session } from '@/shared/models/session.model';

@Injectable({ providedIn: 'root' })
export class TasksApiService {
  private readonly http = inject(HttpClient);
  get(id: number) {
    return this.http.get<Task>(`/api/tasks/${id}`);
  }
  conversation(id: number) {
    return this.http.post<Session>(`/api/tasks/${id}/conversation`, {});
  }
  list(repoId: number, state: 'active' | 'finished' = 'active', cursor = 0) {
    return this.http.get<Task[]>(`/api/repos/${repoId}/tasks`, {
      params: { state, limit: 20, cursor },
    });
  }
  defaults(repoId: number, name = '') {
    return this.http.get<{ baseRef: string | null; branchName: string }>(
      `/api/repos/${repoId}/tasks/defaults`,
      { params: { name } },
    );
  }
  create(repoId: number, setup: TaskSetup) {
    return this.http.post<Task>(`/api/repos/${repoId}/tasks`, setup);
  }
  retry(id: number, patch: Partial<TaskSetup>) {
    return this.http.post<Task>(`/api/tasks/${id}/retry`, patch);
  }
  rename(id: number, name: string) {
    return this.http.patch<Task>(`/api/tasks/${id}`, { name });
  }
  move(repoId: number, taskId: number, beforeTaskId: number | null) {
    return this.http.patch<{ taskIds: number[] }>(
      `/api/repos/${repoId}/tasks/${taskId}/order`,
      { beforeTaskId },
    );
  }
  draft(id: number, text: string) {
    return this.http.patch(`/api/tasks/${id}/draft`, { text });
  }
  preview(id: number) {
    return this.http.get<{ agents: number; terminals: number; actions: number }>(
      `/api/tasks/${id}/finish-preview`,
    );
  }
  finish(id: number, confirmStop = false) {
    return this.http.post<Task>(`/api/tasks/${id}/finish`, { confirmStop });
  }
  reopen(id: number) {
    return this.http.post<Task>(`/api/tasks/${id}/reopen`, {});
  }
}
