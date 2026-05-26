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

const SUCCEEDED_PENDING_CLEANUP_MS = 5000;

@Injectable({ providedIn: 'root' })
export class PendingWorkspaceCreationsService {
  private readonly workspacesService = inject(WorkspacesService);
  private readonly navigationService = inject(NavigationService);
  private readonly sessionsService = inject(SessionsService);

  private readonly _pending = signal(new Map<string, PendingWorkspaceCreation>());
  readonly pending = this._pending.asReadonly();

  private readonly pollSubscriptions = new Map<string, Subscription>();
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
    const duplicate = this.findByPathKey(next, job.repoId, job.worktreePath);
    if (duplicate && duplicate.jobId !== job.jobId) {
      next.delete(duplicate.jobId);
      this.stopPolling(duplicate.jobId);
      this.clearCleanup(duplicate.jobId);
    }
    this.clearCleanup(job.jobId);
    next.set(job.jobId, pendingJob);
    this._pending.set(next);
    this.expandRepo(job.repoId);
    this.startPolling(job.jobId);
  }

  getByRepo(repoId: number): PendingWorkspaceCreation[] {
    return Array.from(this._pending().values()).filter((job) => job.repoId === repoId);
  }

  getVisibleByRepo(repoId: number, existingWorkspacePaths: readonly string[]): PendingWorkspaceCreation[] {
    const existingPathKeys = new Set(
      existingWorkspacePaths.map((workspacePath) => this.normalizePath(workspacePath)),
    );
    const visibleByPath = new Map<string, PendingWorkspaceCreation>();

    for (const job of this.getByRepo(repoId)) {
      const pathKey = this.normalizePath(job.worktreePath);
      if (existingPathKeys.has(pathKey)) {
        continue;
      }

      const current = visibleByPath.get(pathKey);
      if (!current || this.statusPriority(job.status) >= this.statusPriority(current.status)) {
        visibleByPath.set(pathKey, job);
      }
    }

    return Array.from(visibleByPath.values());
  }

  hasPendingForRepoPath(repoId: number, worktreePath: string): boolean {
    return this.findByPathKey(this._pending(), repoId, worktreePath) !== null;
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

          const updatedJob = {
            ...current,
            status: status.status,
          };
          this.upsert(updatedJob);

          if (status.status === 'succeeded') {
            this.finishSuccess(updatedJob, status.workspace ?? null);
          } else if (status.status === 'failed') {
            this.finishFailure(updatedJob, status.error || 'Unknown error');
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
    this.upsert({ ...job, status: 'succeeded' });
    this.scheduleCleanup(job.jobId);
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
    this.clearCleanup(jobId);
    const next = new Map(this._pending());
    next.delete(jobId);
    this._pending.set(next);
  }

  private stopPolling(jobId: string): void {
    this.pollSubscriptions.get(jobId)?.unsubscribe();
    this.pollSubscriptions.delete(jobId);
  }

  private scheduleCleanup(jobId: string): void {
    this.clearCleanup(jobId);
    const timer = setTimeout(() => {
      this.remove(jobId);
    }, SUCCEEDED_PENDING_CLEANUP_MS);
    this.cleanupTimers.set(jobId, timer);
  }

  private clearCleanup(jobId: string): void {
    const timer = this.cleanupTimers.get(jobId);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.cleanupTimers.delete(jobId);
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

  private findByPathKey(
    pending: ReadonlyMap<string, PendingWorkspaceCreation>,
    repoId: number,
    worktreePath: string,
  ): PendingWorkspaceCreation | null {
    const key = this.pendingPathKey(repoId, worktreePath);
    for (const job of pending.values()) {
      if (this.pendingPathKey(job.repoId, job.worktreePath) === key) {
        return job;
      }
    }
    return null;
  }

  private pendingPathKey(repoId: number, worktreePath: string): string {
    return `${repoId}:${this.normalizePath(worktreePath)}`;
  }

  private normalizePath(worktreePath: string): string {
    const trimmed = worktreePath.trim();
    if (trimmed.length <= 1) {
      return trimmed;
    }
    return trimmed.replace(/[\\/]+$/, '');
  }

  private statusPriority(status: WorkspaceCreationJobStatus): number {
    switch (status) {
      case 'running':
        return 3;
      case 'pending':
        return 2;
      case 'succeeded':
        return 1;
      case 'failed':
        return 0;
    }
  }
}
