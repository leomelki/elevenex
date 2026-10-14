import { inject, Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Repo } from '../models/repo.model';

export interface RepositorySuggestion {
  name: string;
  path: string;
}

@Injectable({ providedIn: 'root' })
export class ReposService {
  private http = inject(HttpClient);

  getByProject(projectId: number) {
    return this.http.get<Repo[]>(`/api/projects/${projectId}/repos`);
  }

  add(projectId: number, path: string) {
    return this.http.post<Repo>(`/api/projects/${projectId}/repos`, { path });
  }

  validatePath(path: string) {
    return this.http.post<{ name: string; path: string }>('/api/repos/validate', { path });
  }

  suggestRepositories(query = '', limit = 20) {
    const params = new HttpParams().set('query', query.slice(0, 512)).set('limit', limit);
    return this.http.get<RepositorySuggestion[]>('/api/repos/suggestions', { params });
  }

  remove(id: number) {
    return this.http.delete<Repo>(`/api/repos/${id}`);
  }

  updatePreferredContextRootRef(id: number, preferredContextRootRef: string | null) {
    return this.http.patch<Repo>(`/api/repos/${id}/context-root`, {
      preferredContextRootRef,
    });
  }
}
