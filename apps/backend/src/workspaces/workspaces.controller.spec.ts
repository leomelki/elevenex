import { NotFoundException } from '@nestjs/common';
import { WorkspacesController } from './workspaces.controller.js';

describe('WorkspacesController', () => {
  const makeDb = (repos: Array<{ id: number; name?: string; path: string }>) => ({
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => repos),
      })),
    })),
  });

  it('starts a background workspace creation job and returns accepted payload', async () => {
    const jobsServiceMock = {
      startJob: jest.fn(() => ({
        id: 'job-1',
        repoId: 7,
        name: 'Feature',
        startPoint: 'feature',
        worktreePath: '/tmp/test-repo/.worktrees/feature',
        status: 'pending',
      })),
      getJob: jest.fn(),
    };
    const controller = new WorkspacesController(
      { listForRepo: jest.fn() } as any,
      jobsServiceMock as any,
      makeDb([{ id: 7, name: 'test-repo', path: '/tmp/test-repo' }]) as any,
    );

    await expect(controller.create('7', {
      name: 'Feature',
      path: '/tmp/test-repo/.worktrees/feature',
      startPoint: 'feature',
    })).resolves.toEqual({
      jobId: 'job-1',
      repoId: 7,
      name: 'Feature',
      startPoint: 'feature',
      worktreePath: '/tmp/test-repo/.worktrees/feature',
      status: 'pending',
    });
    expect(jobsServiceMock.startJob).toHaveBeenCalledWith(
      { id: 7, name: 'test-repo', path: '/tmp/test-repo' },
      {
        name: 'Feature',
        path: '/tmp/test-repo/.worktrees/feature',
        startPoint: 'feature',
      },
    );
  });

  it('returns workspace creation job status', async () => {
    const workspace = {
      id: 99,
      repoId: 7,
      name: 'Feature',
      path: '/tmp/test-repo/.worktrees/feature',
    };
    const jobsServiceMock = {
      startJob: jest.fn(),
      getJob: jest.fn(() => ({
        id: 'job-1',
        status: 'succeeded',
        name: 'Feature',
        startPoint: 'feature',
        worktreePath: '/tmp/test-repo/.worktrees/feature',
        workspace,
        error: null,
      })),
    };
    const controller = new WorkspacesController(
      { listForRepo: jest.fn() } as any,
      jobsServiceMock as any,
      makeDb([{ id: 7, name: 'test-repo', path: '/tmp/test-repo' }]) as any,
    );

    await expect(controller.getCreateWorkspaceJob('7', 'job-1')).resolves.toEqual({
      jobId: 'job-1',
      status: 'succeeded',
      name: 'Feature',
      startPoint: 'feature',
      worktreePath: '/tmp/test-repo/.worktrees/feature',
      workspace,
      error: null,
    });
    expect(jobsServiceMock.getJob).toHaveBeenCalledWith(7, 'job-1');
  });

  it('throws when the repo does not exist for workspace creation', async () => {
    const controller = new WorkspacesController(
      { listForRepo: jest.fn() } as any,
      { startJob: jest.fn(), getJob: jest.fn() } as any,
      makeDb([]) as any,
    );

    await expect(
      controller.create('999', { name: 'Feature', startPoint: 'feature' }),
    ).rejects.toThrow(NotFoundException);
  });
});
