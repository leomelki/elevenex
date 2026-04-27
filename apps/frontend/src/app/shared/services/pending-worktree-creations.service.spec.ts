import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { PendingWorktreeCreationsService } from './pending-worktree-creations.service';
import { WorktreesService } from './worktrees.service';
import { NavigationService } from './navigation.service';
import { SessionsService } from './sessions.service';

vi.mock('ngx-sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('PendingWorktreeCreationsService', () => {
  const worktreesServiceMock = {
    getCreateJob: vi.fn(),
  };
  const navigationServiceMock = {
    refreshTree: vi.fn(),
    openSession: vi.fn(),
  };
  const sessionsServiceMock = {
    create: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    worktreesServiceMock.getCreateJob.mockReset();
    navigationServiceMock.refreshTree.mockReset();
    navigationServiceMock.openSession.mockReset();
    sessionsServiceMock.create.mockReset();

    TestBed.configureTestingModule({
      providers: [
        PendingWorktreeCreationsService,
        { provide: WorktreesService, useValue: worktreesServiceMock },
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

  it('removes a pending item and refreshes nav on successful completion', () => {
    worktreesServiceMock.getCreateJob.mockReturnValue(of({
      jobId: 'job-1',
      status: 'succeeded',
      branchName: 'feature',
      worktreePath: '/tmp/repo/.worktrees/feature',
      result: { path: '/tmp/repo/.worktrees/feature' },
      error: null,
    }));

    const service = TestBed.inject(PendingWorktreeCreationsService);
    service.register({
      jobId: 'job-1',
      repoId: 7,
      branchName: 'feature',
      worktreePath: '/tmp/repo/.worktrees/feature',
      status: 'pending',
    }, false);

    expect(service.getByRepo(7)).toHaveLength(1);
    vi.advanceTimersByTime(0);

    expect(service.getByRepo(7)).toHaveLength(0);
    expect(navigationServiceMock.refreshTree).toHaveBeenCalledOnce();
  });

  it('creates and opens a session after successful completion when requested', () => {
    worktreesServiceMock.getCreateJob.mockReturnValue(of({
      jobId: 'job-1',
      status: 'succeeded',
      branchName: 'feature',
      worktreePath: '/tmp/repo/.worktrees/feature',
      result: { path: '/tmp/repo/.worktrees/feature' },
      error: null,
    }));
    sessionsServiceMock.create.mockReturnValue(of({ id: 44 }));

    const service = TestBed.inject(PendingWorktreeCreationsService);
    service.register({
      jobId: 'job-1',
      repoId: 7,
      branchName: 'feature',
      worktreePath: '/tmp/repo/.worktrees/feature',
      status: 'pending',
    }, true);

    vi.advanceTimersByTime(0);

    expect(sessionsServiceMock.create).toHaveBeenCalledWith({
      repoId: 7,
      branchName: 'feature',
      worktreePath: '/tmp/repo/.worktrees/feature',
    });
    expect(navigationServiceMock.openSession).toHaveBeenCalledWith(44);
  });

  it('removes a pending item on failure', () => {
    worktreesServiceMock.getCreateJob.mockReturnValue(throwError(() => ({
      error: { message: 'Nope' },
    })));

    const service = TestBed.inject(PendingWorktreeCreationsService);
    service.register({
      jobId: 'job-1',
      repoId: 7,
      branchName: 'feature',
      worktreePath: '/tmp/repo/.worktrees/feature',
      status: 'pending',
    }, false);

    vi.advanceTimersByTime(0);

    expect(service.getByRepo(7)).toHaveLength(0);
  });
});
