import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { HttpParams } from '@angular/common/http';
import { Project } from '../models/project.model';

export type ProjectListState = 'active' | 'archived' | 'all';

@Injectable({ providedIn: 'root' })
export class ProjectsService {
  private http = inject(HttpClient);

  getAll(state: ProjectListState = 'active') {
    const params = state === 'active'
      ? undefined
      : new HttpParams().set('state', state);
    return this.http.get<Project[]>('/api/projects', { params });
  }

  getOne(id: number) {
    return this.http.get<Project>(`/api/projects/${id}`);
  }

  create(name: string) {
    return this.http.post<Project>('/api/projects', { name });
  }

  archive(id: number) {
    return this.http.post<Project>(`/api/projects/${id}/archive`, {});
  }

  unarchive(id: number) {
    return this.http.post<Project>(`/api/projects/${id}/unarchive`, {});
  }

  updateAgentInstructions(id: number, instructions: string | null) {
    return this.http.patch<Project>(`/api/projects/${id}/agent-instructions`, { instructions });
  }

  delete(id: number) {
    return this.http.delete<Project>(`/api/projects/${id}`);
  }
}
