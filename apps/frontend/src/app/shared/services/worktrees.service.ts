import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CreateWorktreeJob, CreateWorktreeJobStatus, WorktreeInfo } from '../models/worktree.model';

@Injectable({ providedIn: 'root' })
export class WorktreesService {
  private http = inject(HttpClient);

  getByRepo(repoId: number) {
    return this.http.get<WorktreeInfo[]>(`/api/repos/${repoId}/worktrees`);
  }

  create(repoId: number, branchName: string, worktreePath?: string) {
    return this.http.post<CreateWorktreeJob>(`/api/repos/${repoId}/worktrees`, { branchName, worktreePath });
  }

  getCreateJob(repoId: number, jobId: string) {
    return this.http.get<CreateWorktreeJobStatus>(`/api/repos/${repoId}/worktrees/jobs/${jobId}`);
  }

  remove(repoId: number, worktreePath: string) {
    return this.http.delete<void>(`/api/repos/${repoId}/worktrees`, { body: { worktreePath } });
  }

  removeFromProject(repoId: number, worktreePath: string) {
    return this.http.delete<void>(`/api/repos/${repoId}/worktrees/project-attachment`, {
      body: { worktreePath },
    });
  }
}
