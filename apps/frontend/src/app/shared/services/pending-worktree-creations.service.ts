import { Injectable, inject, signal } from '@angular/core';
import { Subscription, timer } from 'rxjs';
import { SessionsService } from './sessions.service';
import { WorktreesService } from './worktrees.service';
import { NavigationService } from './navigation.service';
import { toast } from 'ngx-sonner';

export interface PendingWorktreeCreation {
  jobId: string;
  repoId: number;
  branchName: string;
  worktreePath: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  autoCreateSession: boolean;
}

@Injectable({ providedIn: 'root' })
export class PendingWorktreeCreationsService {
  private readonly worktreesService = inject(WorktreesService);
  private readonly navigationService = inject(NavigationService);
  private readonly sessionsService = inject(SessionsService);

  private readonly _pending = signal(new Map<string, PendingWorktreeCreation>());
  readonly pending = this._pending.asReadonly();

  private readonly pollSubscriptions = new Map<string, Subscription>();

  register(job: {
    jobId: string;
    repoId: number;
    branchName: string;
    worktreePath: string;
    status: 'pending' | 'running' | 'succeeded' | 'failed';
  }, autoCreateSession: boolean): void {
    const pendingJob: PendingWorktreeCreation = {
      ...job,
      autoCreateSession,
    };
    const next = new Map(this._pending());
    next.set(job.jobId, pendingJob);
    this._pending.set(next);
    this.startPolling(job.jobId);
  }

  getByRepo(repoId: number): PendingWorktreeCreation[] {
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

      this.worktreesService.getCreateJob(job.repoId, jobId).subscribe({
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
            this.finishSuccess(current);
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

  private finishSuccess(job: PendingWorktreeCreation): void {
    this.stopPolling(job.jobId);
    this.remove(job.jobId);
    toast.success('Worktree created');
    this.navigationService.refreshTree();

    if (!job.autoCreateSession) {
      return;
    }

    this.sessionsService.create({
      repoId: job.repoId,
      branchName: job.branchName,
      worktreePath: job.worktreePath,
    }).subscribe({
      next: (session) => {
        toast.success('Session created');
        this.navigationService.refreshTree();
        this.navigationService.openSession(session.id);
      },
      error: (err) => {
        const msg = err?.error?.message || 'Unknown error';
        toast.error(`Could not create session. ${msg}`);
      },
    });
  }

  private finishFailure(job: PendingWorktreeCreation, message: string): void {
    this.stopPolling(job.jobId);
    this.remove(job.jobId);
    toast.error(`Could not create worktree. ${message}`);
  }

  private upsert(job: PendingWorktreeCreation): void {
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
}
