import { Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { WorktreesService, WorktreeInfo } from './worktrees.service.js';

export type WorktreeCreationJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface WorktreeCreationJob {
  id: string;
  repoId: number;
  repoPath: string;
  branchName: string;
  worktreePath: string;
  status: WorktreeCreationJobStatus;
  error: string | null;
  result: WorktreeInfo | null;
  createdAt: string;
  updatedAt: string;
}

const FINISHED_JOB_TTL_MS = 60_000;

@Injectable()
export class WorktreeCreationJobsService implements OnModuleDestroy {
  private readonly jobs = new Map<string, WorktreeCreationJob>();
  private readonly activeJobKeys = new Map<string, string>();
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly worktreesService: WorktreesService) {}

  startJob(
    repoId: number,
    repoPath: string,
    branchName: string,
    worktreePath: string,
  ): WorktreeCreationJob {
    const key = this.buildActiveKey(repoId, branchName, worktreePath);
    const existingJobId = this.activeJobKeys.get(key);
    if (existingJobId) {
      const existing = this.jobs.get(existingJobId);
      if (existing) {
        return existing;
      }
      this.activeJobKeys.delete(key);
    }

    const now = new Date().toISOString();
    const job: WorktreeCreationJob = {
      id: this.createJobId(),
      repoId,
      repoPath,
      branchName,
      worktreePath,
      status: 'pending',
      error: null,
      result: null,
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(job.id, job);
    this.activeJobKeys.set(key, job.id);
    void this.runJob(job.id);
    return job;
  }

  getJob(repoId: number, jobId: string): WorktreeCreationJob {
    const job = this.jobs.get(jobId);
    if (!job || job.repoId !== repoId) {
      throw new NotFoundException(`Worktree creation job ${jobId} not found`);
    }

    return job;
  }

  onModuleDestroy(): void {
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.cleanupTimers.clear();
  }

  private async runJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    this.updateJob(jobId, {
      status: 'running',
      error: null,
    });

    try {
      const result = await this.worktreesService.createWorktree(
        job.repoPath,
        job.branchName,
        job.worktreePath,
      );
      this.updateJob(jobId, {
        status: 'succeeded',
        result,
      });
    } catch (error: unknown) {
      this.updateJob(jobId, {
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      this.activeJobKeys.delete(this.buildActiveKey(job.repoId, job.branchName, job.worktreePath));
      this.scheduleCleanup(jobId);
    }
  }

  private updateJob(jobId: string, patch: Partial<WorktreeCreationJob>): void {
    const current = this.jobs.get(jobId);
    if (!current) return;

    this.jobs.set(jobId, {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  }

  private scheduleCleanup(jobId: string): void {
    const existingTimer = this.cleanupTimers.get(jobId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.cleanupTimers.delete(jobId);
      this.jobs.delete(jobId);
    }, FINISHED_JOB_TTL_MS);

    this.cleanupTimers.set(jobId, timer);
  }

  private buildActiveKey(repoId: number, branchName: string, worktreePath: string): string {
    return `${repoId}:${branchName}:${worktreePath}`;
  }

  private createJobId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
