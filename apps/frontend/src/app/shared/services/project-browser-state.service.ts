import { inject, Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';

export interface ProjectBrowserTabState {
  tabId: string;
  url: string;
  position: number;
  customTitle: string | null;
}

export interface ProjectBrowserStateSnapshot {
  projectId: number;
  activeTabId: string | null;
  tabs: ProjectBrowserTabState[];
}

@Injectable({ providedIn: 'root' })
export class ProjectBrowserStateService {
  private readonly http = inject(HttpClient);

  get(projectId: number) {
    const params = new HttpParams().set('projectId', String(projectId));
    return this.http.get<ProjectBrowserStateSnapshot>('/api/project-browser-state', { params });
  }

  save(snapshot: ProjectBrowserStateSnapshot) {
    return this.http.patch<ProjectBrowserStateSnapshot>('/api/project-browser-state', snapshot);
  }
}
