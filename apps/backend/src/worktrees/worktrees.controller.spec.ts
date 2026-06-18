import { NotFoundException } from '@nestjs/common';
import { WorktreesController } from './worktrees.controller.js';

describe('WorktreesController', () => {
  const makeDb = (
    repos: Array<{ id: number; name?: string; path: string }>,
  ) => ({
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
    const projectsServiceMock = { assertProjectIsActive: jest.fn() };
    const controller = new WorktreesController(
      worktreesServiceMock as any,
      {
        listForRepo: jest.fn(),
        createForRepo: jest.fn(),
        linkToProject: jest.fn(),
        streamForRepo: jest.fn(),
      } as any,
      jobsServiceMock as any,
      sessionsServiceMock as any,
      projectsServiceMock as any,
      makeDb([{ id: 7, name: 'test-repo', path: '/tmp/test-repo' }]) as any,
    );

    const result = await controller.removeWorktreeFromProject('7', {
      worktreePath: '/tmp/test-repo/.worktrees/feature',
    });

    expect(result).toEqual({ success: true });
    expect(
      sessionsServiceMock.deleteByRepoAndWorktreePath,
    ).toHaveBeenCalledWith(7, '/tmp/test-repo/.worktrees/feature');
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
    const projectsServiceMock = { assertProjectIsActive: jest.fn() };
    const controller = new WorktreesController(
      worktreesServiceMock as any,
      {
        listForRepo: jest.fn(),
        createForRepo: jest.fn(),
        linkToProject: jest.fn(),
        streamForRepo: jest.fn(),
      } as any,
      jobsServiceMock as any,
      sessionsServiceMock as any,
      projectsServiceMock as any,
      makeDb([{ id: 7, name: 'test-repo', path: '/tmp/test-repo' }]) as any,
    );

    const result = await controller.removeWorktree('7', {
      worktreePath: '/tmp/test-repo/.worktrees/feature',
    });

    expect(result).toEqual({ success: true });
    expect(
      sessionsServiceMock.deleteByRepoAndWorktreePath,
    ).toHaveBeenCalledWith(7, '/tmp/test-repo/.worktrees/feature');
    expect(sessionsServiceMock.deleteByWorktreePath).not.toHaveBeenCalled();
    expect(worktreesServiceMock.removeWorktree).toHaveBeenCalledWith(
      '/tmp/test-repo',
      '/tmp/test-repo/.worktrees/feature',
    );
  });

  it('throws when the repo does not exist for project removal', async () => {
    const controller = new WorktreesController(
      { removeWorktree: jest.fn() } as any,
      {
        listForRepo: jest.fn(),
        createForRepo: jest.fn(),
        linkToProject: jest.fn(),
        streamForRepo: jest.fn(),
      } as any,
      { startJob: jest.fn(), getJob: jest.fn() } as any,
      {
        deleteByWorktreePath: jest.fn(),
        deleteByRepoAndWorktreePath: jest.fn(),
      } as any,
      { assertProjectIsActive: jest.fn() } as any,
      makeDb([]) as any,
    );

    await expect(
      controller.removeWorktreeFromProject('999', {
        worktreePath: '/tmp/missing',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('starts a background worktree creation job and returns accepted payload', async () => {
    const jobsServiceMock = {
      startJob: jest.fn(() => ({
        id: 'job-1',
        branchName: 'feature',
        worktreePath: '/tmp/.worktrees/test-repo/feature',
        status: 'pending',
      })),
      getJob: jest.fn(),
    };
    const controller = new WorktreesController(
      { removeWorktree: jest.fn() } as any,
      {
        listForRepo: jest.fn(),
        createForRepo: jest.fn(),
        linkToProject: jest.fn(),
        streamForRepo: jest.fn(),
      } as any,
      jobsServiceMock as any,
      {
        deleteByWorktreePath: jest.fn(),
        deleteByRepoAndWorktreePath: jest.fn(),
      } as any,
      { assertProjectIsActive: jest.fn() } as any,
      makeDb([{ id: 7, name: 'test-repo', path: '/tmp/test-repo' }]) as any,
    );

    await expect(
      controller.createWorktree('7', { branchName: 'feature' }),
    ).resolves.toEqual({
      jobId: 'job-1',
      repoId: 7,
      branchName: 'feature',
      worktreePath: '/tmp/.worktrees/test-repo/feature',
      status: 'pending',
    });
    expect(jobsServiceMock.startJob).toHaveBeenCalledWith(
      7,
      '/tmp/test-repo',
      'feature',
      expect.stringMatching(/[\\/]tmp[\\/]\.worktrees[\\/]test-repo[\\/]feature$/),
      undefined,
    );
  });

  it('streams worktree pool entries as SSE events', async () => {
    const worktreePoolServiceMock = {
      listForRepo: jest.fn(),
      createForRepo: jest.fn(),
      linkToProject: jest.fn(),
      streamForRepo: jest
        .fn()
        .mockImplementation(async (_repo: any, onItem: (item: { id: number; name: string }) => void) => {
          onItem({ id: 11, name: 'feature' });
          onItem({ id: 12, name: 'feature-two' });
          return 2;
        }),
    };
    const controller = new WorktreesController(
      { removeWorktree: jest.fn() } as any,
      worktreePoolServiceMock as any,
      { startJob: jest.fn(), getJob: jest.fn() } as any,
      {
        deleteByWorktreePath: jest.fn(),
        deleteByRepoAndWorktreePath: jest.fn(),
      } as any,
      { assertProjectIsActive: jest.fn() } as any,
      makeDb([{ id: 7, name: 'test-repo', path: '/tmp/test-repo' }]) as any,
    );

    const stream = await controller.streamListWorktreePool('7');
    const events: any[] = [];
    await new Promise((resolve, reject) => {
      stream.subscribe({
        next: (event) => {
          events.push(event);
        },
        complete: resolve,
        error: reject,
      });
    });

    expect(events).toHaveLength(3);
    expect((events[0] as any).type).toBe('worktree');
    expect((events[0] as any).data).toEqual({ id: 11, name: 'feature' });
    expect((events[1] as any).type).toBe('worktree');
    expect((events[2] as any).type).toBe('done');
    expect(events[2].data).toEqual({ total: 2 });
    expect(worktreePoolServiceMock.streamForRepo).toHaveBeenCalled();
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
      {
        listForRepo: jest.fn(),
        createForRepo: jest.fn(),
        linkToProject: jest.fn(),
        streamForRepo: jest.fn(),
      } as any,
      jobsServiceMock as any,
      {
        deleteByWorktreePath: jest.fn(),
        deleteByRepoAndWorktreePath: jest.fn(),
      } as any,
      { assertProjectIsActive: jest.fn() } as any,
      makeDb([{ id: 7, path: '/tmp/test-repo' }]) as any,
    );

    await expect(
      controller.getCreateWorktreeJob('7', 'job-1'),
    ).resolves.toEqual({
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
