import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { signal } from '@angular/core';
import { PendingWorkspaceCreationsService } from './pending-workspace-creations.service';
import { WorkspacesService } from './workspaces.service';
import { NavigationService } from './navigation.service';
import { SessionsService } from './sessions.service';

vi.mock('ngx-sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('PendingWorkspaceCreationsService', () => {
  const tree = signal([
    {
      id: 3,
      name: 'Project',
      repos: [{ id: 7, name: 'Repo', path: '/tmp/repo', branches: [] }],
    },
  ]);
  const workspacesServiceMock = {
    getCreateJob: vi.fn(),
  };
  const navigationServiceMock = {
    refreshTree: vi.fn(),
    openSession: vi.fn(),
    expandKey: vi.fn(),
    tree: tree.asReadonly(),
  };
  const sessionsServiceMock = {
    create: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    workspacesServiceMock.getCreateJob.mockReset();
    navigationServiceMock.refreshTree.mockReset();
    navigationServiceMock.openSession.mockReset();
    navigationServiceMock.expandKey.mockReset();
    sessionsServiceMock.create.mockReset();

    TestBed.configureTestingModule({
      providers: [
        PendingWorkspaceCreationsService,
        { provide: WorkspacesService, useValue: workspacesServiceMock },
        { provide: NavigationService, useValue: navigationServiceMock },
        { provide: SessionsService, useValue: sessionsServiceMock },
      ],
    });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('keeps a succeeded item visible briefly and refreshes nav on successful completion', () => {
    workspacesServiceMock.getCreateJob.mockReturnValue(of({
      jobId: 'job-1',
      status: 'succeeded',
      name: 'Feature',
      startPoint: 'feature',
      worktreePath: '/tmp/repo/.worktrees/feature',
      workspace: { id: 99 },
      error: null,
    }));

    const service = TestBed.inject(PendingWorkspaceCreationsService);
    service.register({
      jobId: 'job-1',
      repoId: 7,
      name: 'Feature',
      startPoint: 'feature',
      worktreePath: '/tmp/repo/.worktrees/feature',
      status: 'pending',
    }, false);

    expect(service.getByRepo(7)).toHaveLength(1);
    expect(navigationServiceMock.expandKey).toHaveBeenCalledWith('repo-7');
    expect(navigationServiceMock.expandKey).toHaveBeenCalledWith('project-3');

    vi.advanceTimersByTime(0);

    expect(service.getByRepo(7)).toEqual([
      expect.objectContaining({
        jobId: 'job-1',
        status: 'succeeded',
      }),
    ]);
    expect(navigationServiceMock.refreshTree).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(4999);
    expect(service.getByRepo(7)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(service.getByRepo(7)).toHaveLength(0);
  });

  it('creates and opens a session after successful completion when requested', () => {
    workspacesServiceMock.getCreateJob.mockReturnValue(of({
      jobId: 'job-1',
      status: 'succeeded',
      name: 'Feature',
      startPoint: 'feature',
      worktreePath: '/tmp/repo/.worktrees/feature',
      workspace: { id: 99 },
      error: null,
    }));
    sessionsServiceMock.create.mockReturnValue(of({ id: 44 }));

    const service = TestBed.inject(PendingWorkspaceCreationsService);
    service.register({
      jobId: 'job-1',
      repoId: 7,
      name: 'Feature',
      startPoint: 'feature',
      worktreePath: '/tmp/repo/.worktrees/feature',
      status: 'pending',
    }, true);

    vi.advanceTimersByTime(0);

    expect(sessionsServiceMock.create).toHaveBeenCalledWith({
      repoId: 7,
      workspaceId: 99,
    });
    expect(navigationServiceMock.openSession).toHaveBeenCalledWith(44);
  });

  it('removes a pending item on failure', () => {
    workspacesServiceMock.getCreateJob.mockReturnValue(throwError(() => ({
      error: { message: 'Nope' },
    })));

    const service = TestBed.inject(PendingWorkspaceCreationsService);
    service.register({
      jobId: 'job-1',
      repoId: 7,
      name: 'Feature',
      startPoint: 'feature',
      worktreePath: '/tmp/repo/.worktrees/feature',
      status: 'pending',
    }, false);

    vi.advanceTimersByTime(0);

    expect(service.getByRepo(7)).toHaveLength(0);
  });

  it('deduplicates pending items by repo and workspace path', () => {
    workspacesServiceMock.getCreateJob.mockReturnValue(of({
      jobId: 'job-2',
      status: 'succeeded',
      name: 'Feature',
      startPoint: 'feature',
      worktreePath: '/tmp/repo/.worktrees/feature',
      workspace: { id: 99 },
      error: null,
    }));

    const service = TestBed.inject(PendingWorkspaceCreationsService);
    service.register({
      jobId: 'job-1',
      repoId: 7,
      name: 'Feature',
      startPoint: 'feature',
      worktreePath: '/tmp/repo/.worktrees/feature',
      status: 'pending',
    }, false);
    service.register({
      jobId: 'job-2',
      repoId: 7,
      name: 'Feature duplicate',
      startPoint: 'feature',
      worktreePath: '/tmp/repo/.worktrees/feature/',
      status: 'pending',
    }, false);

    expect(service.getByRepo(7)).toEqual([
      expect.objectContaining({
        jobId: 'job-2',
        name: 'Feature duplicate',
      }),
    ]);
    expect(service.getVisibleByRepo(7, [])).toHaveLength(1);
    expect(service.hasPendingForRepoPath(7, '/tmp/repo/.worktrees/feature')).toBe(true);
  });

  it('hides visible pending items when the workspace path exists in the tree', () => {
    workspacesServiceMock.getCreateJob.mockReturnValue(of({
      jobId: 'job-1',
      status: 'succeeded',
      name: 'Feature',
      startPoint: 'feature',
      worktreePath: '/tmp/repo/.worktrees/feature',
      workspace: { id: 99 },
      error: null,
    }));

    const service = TestBed.inject(PendingWorkspaceCreationsService);
    service.register({
      jobId: 'job-1',
      repoId: 7,
      name: 'Feature',
      startPoint: 'feature',
      worktreePath: '/tmp/repo/.worktrees/feature',
      status: 'pending',
    }, false);

    expect(service.getVisibleByRepo(7, ['/tmp/repo/.worktrees/feature/'])).toHaveLength(0);
  });
});
