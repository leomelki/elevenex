import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Repo } from '../models/repo.model';

@Injectable({ providedIn: 'root' })
export class ReposService {
  private http = inject(HttpClient);

  getByProject(projectId: number) {
    return this.http.get<Repo[]>(`/api/projects/${projectId}/repos`);
  }

  add(projectId: number, path: string) {
    return this.http.post<Repo>(`/api/projects/${projectId}/repos`, { path });
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
