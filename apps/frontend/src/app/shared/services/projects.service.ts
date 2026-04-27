import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Project } from '../models/project.model';

@Injectable({ providedIn: 'root' })
export class ProjectsService {
  private http = inject(HttpClient);

  getAll() {
    return this.http.get<Project[]>('/api/projects');
  }

  getOne(id: number) {
    return this.http.get<Project>(`/api/projects/${id}`);
  }

  create(name: string) {
    return this.http.post<Project>('/api/projects', { name });
  }

  delete(id: number) {
    return this.http.delete<Project>(`/api/projects/${id}`);
  }
}
