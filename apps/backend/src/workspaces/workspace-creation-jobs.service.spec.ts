import { BadRequestException } from '@nestjs/common';
import { WorkspaceCreationJobsService } from './workspace-creation-jobs.service.js';

describe('WorkspaceCreationJobsService', () => {
  const repo = {
    id: 7,
    projectId: 1,
    name: 'test-repo',
    path: '/tmp/test-repo',
    color: null,
    createdAt: '2026-04-20T10:00:00.000Z',
    updatedAt: '2026-04-20T10:00:00.000Z',
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-20T10:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('starts a job and exposes the successful workspace result', async () => {
    const workspace = {
      id: 99,
      repoId: 7,
      name: 'Feature',
      path: '/tmp/test-repo/.worktrees/feature',
      isDefault: false,
      createdFromRef: 'feature',
    };
    const createWorkspace = jest.fn().mockResolvedValue(workspace);
    const service = new WorkspaceCreationJobsService({ createWorkspace } as any);

    const job = service.startJob(repo as any, {
      name: 'Feature',
      path: '/tmp/test-repo/.worktrees/feature',
      startPoint: 'feature',
    });

    expect(job.status).toBe('pending');

    await Promise.resolve();
    await Promise.resolve();

    const updated = service.getJob(7, job.id);
    expect(createWorkspace).toHaveBeenCalledWith(repo, {
      name: 'Feature',
      path: '/tmp/test-repo/.worktrees/feature',
      startPoint: 'feature',
      createBranch: false,
      branchName: undefined,
    });
    expect(updated.status).toBe('succeeded');
    expect(updated.workspace).toBe(workspace);
  });

  it('marks a failed job with the surfaced error', async () => {
    const createWorkspace = jest.fn().mockRejectedValue(new BadRequestException('boom'));
    const service = new WorkspaceCreationJobsService({ createWorkspace } as any);

    const job = service.startJob(repo as any, {
      name: 'Feature',
      path: '/tmp/test-repo/.worktrees/feature',
      startPoint: 'feature',
    });

    await Promise.resolve();
    await Promise.resolve();

    const updated = service.getJob(7, job.id);
    expect(updated.status).toBe('failed');
    expect(updated.error).toContain('boom');
  });

  it('deduplicates active jobs for the same repo and path', async () => {
    let resolveJob: ((value: unknown) => void) | null = null;
    const createWorkspace = jest.fn().mockImplementation(() => new Promise((resolve) => {
      resolveJob = resolve;
    }));
    const service = new WorkspaceCreationJobsService({ createWorkspace } as any);

    const first = service.startJob(repo as any, {
      name: 'Feature',
      path: '/tmp/test-repo/.worktrees/feature',
      startPoint: 'feature',
    });
    const second = service.startJob(repo as any, {
      name: 'Other label',
      path: '/tmp/test-repo/.worktrees/feature',
      startPoint: 'main',
    });

    expect(second.id).toBe(first.id);

    await Promise.resolve();
    expect(createWorkspace).toHaveBeenCalledTimes(1);

    resolveJob?.({
      id: 99,
      repoId: 7,
      name: 'Feature',
      path: '/tmp/test-repo/.worktrees/feature',
    });

    await Promise.resolve();
    await Promise.resolve();

    const third = service.startJob(repo as any, {
      name: 'Feature',
      path: '/tmp/test-repo/.worktrees/feature',
      startPoint: 'feature',
    });
    expect(third.id).not.toBe(first.id);
  });

  it('expires finished jobs after the ttl', async () => {
    const service = new WorkspaceCreationJobsService({
      createWorkspace: jest.fn().mockResolvedValue({
        id: 99,
        repoId: 7,
        name: 'Feature',
        path: '/tmp/test-repo/.worktrees/feature',
      }),
    } as any);

    const job = service.startJob(repo as any, {
      name: 'Feature',
      path: '/tmp/test-repo/.worktrees/feature',
      startPoint: 'feature',
    });
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(60_000);

    expect(() => service.getJob(7, job.id)).toThrow('not found');
  });
});
