import { BadRequestException } from '@nestjs/common';
import { WorktreeCreationJobsService } from './worktree-creation-jobs.service.js';

describe('WorktreeCreationJobsService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-20T10:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('starts a job and exposes the successful result', async () => {
    const createWorktree = jest.fn().mockResolvedValue({
      path: '/tmp/repo/.worktrees/feature',
      head: 'abc123',
      branch: 'feature',
      isDetached: false,
      isBare: false,
      isLocked: false,
      lockReason: null,
    });
    const service = new WorktreeCreationJobsService({ createWorktree } as any);

    const job = service.startJob(7, '/tmp/repo', 'feature', '/tmp/repo/.worktrees/feature');

    expect(job.status).toBe('pending');

    await Promise.resolve();
    await Promise.resolve();

    const updated = service.getJob(7, job.id);
    expect(createWorktree).toHaveBeenCalledWith('/tmp/repo', 'feature', '/tmp/repo/.worktrees/feature');
    expect(updated.status).toBe('succeeded');
    expect(updated.result?.branch).toBe('feature');
  });

  it('marks a failed job with the surfaced error', async () => {
    const createWorktree = jest.fn().mockRejectedValue(new BadRequestException('boom'));
    const service = new WorktreeCreationJobsService({ createWorktree } as any);

    const job = service.startJob(7, '/tmp/repo', 'feature', '/tmp/repo/.worktrees/feature');

    await Promise.resolve();
    await Promise.resolve();

    const updated = service.getJob(7, job.id);
    expect(updated.status).toBe('failed');
    expect(updated.error).toContain('boom');
  });

  it('deduplicates active jobs for the same repo branch and path', async () => {
    let resolveJob: ((value: unknown) => void) | null = null;
    const createWorktree = jest.fn().mockImplementation(() => new Promise((resolve) => {
      resolveJob = resolve;
    }));
    const service = new WorktreeCreationJobsService({ createWorktree } as any);

    const first = service.startJob(7, '/tmp/repo', 'feature', '/tmp/repo/.worktrees/feature');
    const second = service.startJob(7, '/tmp/repo', 'feature', '/tmp/repo/.worktrees/feature');

    expect(second.id).toBe(first.id);

    await Promise.resolve();
    expect(createWorktree).toHaveBeenCalledTimes(1);

    resolveJob?.({
      path: '/tmp/repo/.worktrees/feature',
      head: 'abc123',
      branch: 'feature',
      isDetached: false,
      isBare: false,
      isLocked: false,
      lockReason: null,
    });

    await Promise.resolve();
    await Promise.resolve();

    const third = service.startJob(7, '/tmp/repo', 'feature', '/tmp/repo/.worktrees/feature');
    expect(third.id).not.toBe(first.id);
  });

  it('expires finished jobs after the ttl', async () => {
    const service = new WorktreeCreationJobsService({
      createWorktree: jest.fn().mockResolvedValue({
        path: '/tmp/repo/.worktrees/feature',
        head: 'abc123',
        branch: 'feature',
        isDetached: false,
        isBare: false,
        isLocked: false,
        lockReason: null,
      }),
    } as any);

    const job = service.startJob(7, '/tmp/repo', 'feature', '/tmp/repo/.worktrees/feature');
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(60_000);

    expect(() => service.getJob(7, job.id)).toThrow('not found');
  });
});
