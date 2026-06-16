import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Session } from '@/shared/models/session.model';

export interface AgentWorkspace {
  projectId: number;
  repoId: number;
  path: string;
  branch: string;
}

export interface AgentOverview {
  workspace: AgentWorkspace;
  sessions: Session[];
}

@Injectable({ providedIn: 'root' })
export class ElevenexAgentService {
  private http = inject(HttpClient);

  getOverview() {
    return this.http.get<AgentOverview>('/api/agent');
  }

  createSession(name?: string) {
    return this.http.post<Session>('/api/agent/sessions', { name });
  }
}
