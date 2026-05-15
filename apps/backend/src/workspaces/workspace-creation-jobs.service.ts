import { Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import * as path from 'node:path';
import * as schema from '../database/schema/index.js';
import { WorkspacesService } from './workspaces.service.js';

export type WorkspaceCreationJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface WorkspaceCreationJob {
  id: string;
  repoId: number;
  repo: typeof schema.repos.$inferSelect;
  name: string;
  startPoint: string;
  worktreePath: string;
  createBranch: boolean;
  branchName: string | null;
  status: WorkspaceCreationJobStatus;
  error: string | null;
  workspace: typeof schema.workspaces.$inferSelect | null;
  createdAt: string;
  updatedAt: string;
}

const FINISHED_JOB_TTL_MS = 60_000;

@Injectable()
export class WorkspaceCreationJobsService implements OnModuleDestroy {
  private readonly jobs = new Map<string, WorkspaceCreationJob>();
  private readonly activeJobKeys = new Map<string, string>();
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly workspacesService: WorkspacesService) {}

  startJob(
    repo: typeof schema.repos.$inferSelect,
    input: {
      name: string;
      path?: string;
      startPoint?: string;
      createBranch?: boolean;
      branchName?: string;
    },
  ): WorkspaceCreationJob {
    const name = input.name.trim();
    const startPoint = input.startPoint?.trim() || 'HEAD';
    const worktreePath = input.path?.trim()
      || path.join(path.dirname(repo.path), '.worktrees', repo.name, this.slugify(name));
    const createBranch = Boolean(input.createBranch);
    const branchName = input.branchName?.trim() || null;
    const key = this.buildActiveKey(repo.id, worktreePath);
    const existingJobId = this.activeJobKeys.get(key);
    if (existingJobId) {
      const existing = this.jobs.get(existingJobId);
      if (existing) {
        return existing;
      }
      this.activeJobKeys.delete(key);
    }

    const now = new Date().toISOString();
    const job: WorkspaceCreationJob = {
      id: this.createJobId(),
      repoId: repo.id,
      repo,
      name,
      startPoint,
      worktreePath,
      createBranch,
      branchName,
      status: 'pending',
      error: null,
      workspace: null,
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(job.id, job);
    this.activeJobKeys.set(key, job.id);
    void this.runJob(job.id);
    return job;
  }

  getJob(repoId: number, jobId: string): WorkspaceCreationJob {
    const job = this.jobs.get(jobId);
    if (!job || job.repoId !== repoId) {
      throw new NotFoundException(`Workspace creation job ${jobId} not found`);
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
      const workspace = await this.workspacesService.createWorkspace(job.repo, {
        name: job.name,
        path: job.worktreePath,
        startPoint: job.startPoint,
        createBranch: job.createBranch,
        branchName: job.branchName ?? undefined,
      });
      this.updateJob(jobId, {
        status: 'succeeded',
        workspace,
      });
    } catch (error: unknown) {
      this.updateJob(jobId, {
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      this.activeJobKeys.delete(this.buildActiveKey(job.repoId, job.worktreePath));
      this.scheduleCleanup(jobId);
    }
  }

  private updateJob(jobId: string, patch: Partial<WorkspaceCreationJob>): void {
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

  private buildActiveKey(repoId: number, worktreePath: string): string {
    return `${repoId}:${worktreePath}`;
  }

  private createJobId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private slugify(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  }
}
