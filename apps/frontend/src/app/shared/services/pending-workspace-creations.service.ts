import { Injectable, inject, signal } from '@angular/core';
import { Subscription, timer } from 'rxjs';
import { SessionsService } from './sessions.service';
import { WorkspacesService, WorkspaceCreationJobStatus } from './workspaces.service';
import { NavigationService } from './navigation.service';
import { toast } from 'ngx-sonner';

export interface PendingWorkspaceCreation {
  jobId: string;
  repoId: number;
  name: string;
  startPoint: string;
  worktreePath: string;
  status: WorkspaceCreationJobStatus;
  autoCreateSession: boolean;
}

@Injectable({ providedIn: 'root' })
export class PendingWorkspaceCreationsService {
  private readonly workspacesService = inject(WorkspacesService);
  private readonly navigationService = inject(NavigationService);
  private readonly sessionsService = inject(SessionsService);

  private readonly _pending = signal(new Map<string, PendingWorkspaceCreation>());
  readonly pending = this._pending.asReadonly();

  private readonly pollSubscriptions = new Map<string, Subscription>();

  register(job: {
    jobId: string;
    repoId: number;
    name: string;
    startPoint: string;
    worktreePath: string;
    status: WorkspaceCreationJobStatus;
  }, autoCreateSession: boolean): void {
    const pendingJob: PendingWorkspaceCreation = {
      ...job,
      autoCreateSession,
    };
    const next = new Map(this._pending());
    next.set(job.jobId, pendingJob);
    this._pending.set(next);
    this.expandRepo(job.repoId);
    this.startPolling(job.jobId);
  }

  getByRepo(repoId: number): PendingWorkspaceCreation[] {
    return Array.from(this._pending().values()).filter((job) => job.repoId === repoId);
  }

  private startPolling(jobId: string): void {
    this.stopPolling(jobId);

    const subscription = timer(0, 1000).subscribe(() => {
      const job = this._pending().get(jobId);
      if (!job) {
        this.stopPolling(jobId);
        return;
      }

      this.workspacesService.getCreateJob(job.repoId, jobId).subscribe({
        next: (status) => {
          const current = this._pending().get(jobId);
          if (!current) {
            this.stopPolling(jobId);
            return;
          }

          this.upsert({
            ...current,
            status: status.status,
          });

          if (status.status === 'succeeded') {
            this.finishSuccess(current, status.workspace ?? null);
          } else if (status.status === 'failed') {
            this.finishFailure(current, status.error || 'Unknown error');
          }
        },
        error: (err) => {
          const msg = err?.error?.message || 'Unknown error';
          const current = this._pending().get(jobId);
          if (!current) {
            this.stopPolling(jobId);
            return;
          }

          this.finishFailure(current, msg);
        },
      });
    });

    this.pollSubscriptions.set(jobId, subscription);
  }

  private finishSuccess(
    job: PendingWorkspaceCreation,
    workspace: { id: number } | null,
  ): void {
    this.stopPolling(job.jobId);
    this.remove(job.jobId);
    toast.success('Workspace created');
    this.navigationService.refreshTree();

    if (!job.autoCreateSession) {
      return;
    }

    if (!workspace) {
      toast.error('Workspace created, but the workspace record was not returned.');
      return;
    }

    this.sessionsService.create({
      repoId: job.repoId,
      workspaceId: workspace.id,
    }).subscribe({
      next: (session) => {
        this.navigationService.refreshTree();
        this.navigationService.openSession(session.id);
      },
      error: (err) => {
        const msg = err?.error?.message || 'Unknown error';
        toast.error(`Could not create session. ${msg}`);
      },
    });
  }

  private finishFailure(job: PendingWorkspaceCreation, message: string): void {
    this.stopPolling(job.jobId);
    this.remove(job.jobId);
    toast.error(`Could not create workspace. ${message}`);
  }

  private upsert(job: PendingWorkspaceCreation): void {
    const next = new Map(this._pending());
    next.set(job.jobId, job);
    this._pending.set(next);
  }

  private remove(jobId: string): void {
    const next = new Map(this._pending());
    next.delete(jobId);
    this._pending.set(next);
  }

  private stopPolling(jobId: string): void {
    this.pollSubscriptions.get(jobId)?.unsubscribe();
    this.pollSubscriptions.delete(jobId);
  }

  private expandRepo(repoId: number): void {
    this.navigationService.expandKey(`repo-${repoId}`);
    const project = this.navigationService.tree().find((candidate) =>
      candidate.repos.some((repo) => repo.id === repoId),
    );
    if (project) {
      this.navigationService.expandKey(`project-${project.id}`);
    }
  }
}
