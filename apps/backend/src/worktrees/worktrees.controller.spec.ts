import { NotFoundException } from '@nestjs/common';
import { WorktreesController } from './worktrees.controller.js';

describe('WorktreesController', () => {
  const makeDb = (repos: Array<{ id: number; path: string }>) => ({
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => repos),
      })),
    })),
  });

  it('removes a worktree from the project by deleting repo-scoped sessions only', async () => {
    const sessionsServiceMock = {
      deleteByWorktreePath: jest.fn(),
      deleteByRepoAndWorktreePath: jest.fn(),
    };
    const worktreesServiceMock = {
      removeWorktree: jest.fn(),
    };
    const jobsServiceMock = {
      startJob: jest.fn(),
      getJob: jest.fn(),
    };
    const controller = new WorktreesController(
      worktreesServiceMock as any,
      jobsServiceMock as any,
      sessionsServiceMock as any,
      makeDb([{ id: 7, path: '/tmp/test-repo' }]) as any,
    );

    const result = await controller.removeWorktreeFromProject('7', {
      worktreePath: '/tmp/test-repo/.worktrees/feature',
    });

    expect(result).toEqual({ success: true });
    expect(sessionsServiceMock.deleteByRepoAndWorktreePath).toHaveBeenCalledWith(
      7,
      '/tmp/test-repo/.worktrees/feature',
    );
    expect(worktreesServiceMock.removeWorktree).not.toHaveBeenCalled();
    expect(sessionsServiceMock.deleteByWorktreePath).not.toHaveBeenCalled();
  });

  it('still removes the git worktree for the destructive flow', async () => {
    const sessionsServiceMock = {
      deleteByWorktreePath: jest.fn(),
      deleteByRepoAndWorktreePath: jest.fn(),
    };
    const worktreesServiceMock = {
      removeWorktree: jest.fn(),
    };
    const jobsServiceMock = {
      startJob: jest.fn(),
      getJob: jest.fn(),
    };
    const controller = new WorktreesController(
      worktreesServiceMock as any,
      jobsServiceMock as any,
      sessionsServiceMock as any,
      makeDb([{ id: 7, path: '/tmp/test-repo' }]) as any,
    );

    const result = await controller.removeWorktree('7', {
      worktreePath: '/tmp/test-repo/.worktrees/feature',
    });

    expect(result).toEqual({ success: true });
    expect(sessionsServiceMock.deleteByWorktreePath).toHaveBeenCalledWith(
      '/tmp/test-repo/.worktrees/feature',
    );
    expect(worktreesServiceMock.removeWorktree).toHaveBeenCalledWith(
      '/tmp/test-repo',
      '/tmp/test-repo/.worktrees/feature',
    );
  });

  it('throws when the repo does not exist for project removal', async () => {
    const controller = new WorktreesController(
      { removeWorktree: jest.fn() } as any,
      { startJob: jest.fn(), getJob: jest.fn() } as any,
      {
        deleteByWorktreePath: jest.fn(),
        deleteByRepoAndWorktreePath: jest.fn(),
      } as any,
      makeDb([]) as any,
    );

    await expect(
      controller.removeWorktreeFromProject('999', { worktreePath: '/tmp/missing' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('starts a background worktree creation job and returns accepted payload', async () => {
    const controller = new WorktreesController(
      { removeWorktree: jest.fn() } as any,
      {
        startJob: jest.fn(() => ({
          id: 'job-1',
          branchName: 'feature',
          worktreePath: '/tmp/.worktrees/feature',
          status: 'pending',
        })),
        getJob: jest.fn(),
      } as any,
      {
        deleteByWorktreePath: jest.fn(),
        deleteByRepoAndWorktreePath: jest.fn(),
      } as any,
      makeDb([{ id: 7, path: '/tmp/test-repo' }]) as any,
    );

    await expect(controller.createWorktree('7', { branchName: 'feature' })).resolves.toEqual({
      jobId: 'job-1',
      repoId: 7,
      branchName: 'feature',
      worktreePath: '/tmp/.worktrees/feature',
      status: 'pending',
    });
  });

  it('returns worktree creation job status for the matching repo', async () => {
    const jobsServiceMock = {
      startJob: jest.fn(),
      getJob: jest.fn(() => ({
        id: 'job-1',
        status: 'succeeded',
        branchName: 'feature',
        worktreePath: '/tmp/.worktrees/feature',
        result: { path: '/tmp/.worktrees/feature' },
        error: null,
      })),
    };
    const controller = new WorktreesController(
      { removeWorktree: jest.fn() } as any,
      jobsServiceMock as any,
      {
        deleteByWorktreePath: jest.fn(),
        deleteByRepoAndWorktreePath: jest.fn(),
      } as any,
      makeDb([{ id: 7, path: '/tmp/test-repo' }]) as any,
    );

    await expect(controller.getCreateWorktreeJob('7', 'job-1')).resolves.toEqual({
      jobId: 'job-1',
      status: 'succeeded',
      branchName: 'feature',
      worktreePath: '/tmp/.worktrees/feature',
      result: { path: '/tmp/.worktrees/feature' },
      error: null,
    });
    expect(jobsServiceMock.getJob).toHaveBeenCalledWith(7, 'job-1');
  });
});
