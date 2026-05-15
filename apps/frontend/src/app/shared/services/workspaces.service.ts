import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Workspace } from '../models/workspace.model';

export interface CreateWorkspacePayload {
  name: string;
  path?: string;
  startPoint?: string;
  createBranch?: boolean;
  branchName?: string;
}

export type WorkspaceCreationJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface CreateWorkspaceJob {
  jobId: string;
  repoId: number;
  name: string;
  startPoint: string;
  worktreePath: string;
  status: WorkspaceCreationJobStatus;
}

export interface CreateWorkspaceJobStatus {
  jobId: string;
  status: WorkspaceCreationJobStatus;
  name: string;
  startPoint: string;
  worktreePath: string;
  workspace?: Workspace | null;
  error?: string | null;
}

export interface CreateWorkspaceBranchPayload {
  branchName: string;
  startPoint?: string;
  destination: 'current-workspace' | 'new-workspace' | 'branch-only';
  workspaceName?: string;
  workspacePath?: string;
}

@Injectable({ providedIn: 'root' })
export class WorkspacesService {
  private http = inject(HttpClient);

  getByRepo(repoId: number) {
    return this.http.get<Workspace[]>(`/api/repos/${repoId}/workspaces`);
  }

  create(repoId: number, payload: CreateWorkspacePayload) {
    return this.http.post<CreateWorkspaceJob>(`/api/repos/${repoId}/workspaces`, payload);
  }

  getCreateJob(repoId: number, jobId: string) {
    return this.http.get<CreateWorkspaceJobStatus>(`/api/repos/${repoId}/workspaces/jobs/${jobId}`);
  }

  rename(repoId: number, workspaceId: number, name: string) {
    return this.http.patch<Workspace>(`/api/repos/${repoId}/workspaces/${workspaceId}`, { name });
  }

  switchBranch(repoId: number, workspaceId: number, branchName: string, force = false) {
    return this.http.post<Workspace>(`/api/repos/${repoId}/workspaces/${workspaceId}/switch-branch`, { branchName, force });
  }

  createBranch(repoId: number, workspaceId: number, payload: CreateWorkspaceBranchPayload) {
    return this.http.post<{ branchName: string; workspace: Workspace | null }>(
      `/api/repos/${repoId}/workspaces/${workspaceId}/create-branch`,
      payload,
    );
  }

  remove(repoId: number, workspaceId: number) {
    return this.http.delete<void>(`/api/repos/${repoId}/workspaces/${workspaceId}`);
  }

  removeFromProject(repoId: number, workspaceId: number) {
    return this.http.delete<void>(`/api/repos/${repoId}/workspaces/${workspaceId}/project-attachment`);
  }
}
