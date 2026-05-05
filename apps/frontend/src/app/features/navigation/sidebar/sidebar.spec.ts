import { Directive, NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { of, Subject } from 'rxjs';
import { NgIcon } from '@ng-icons/core';
import { Router } from '@angular/router';

vi.mock('ngx-sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/shared/runtime/electron-window-controls', () => ({
  getElectronWindowControlsApi: () => undefined,
}));

import { Sidebar } from './sidebar';
import { NavigationService } from '../../../shared/services/navigation.service';
import { SessionsService } from '../../../shared/services/sessions.service';
import { WorktreesService } from '../../../shared/services/worktrees.service';
import { TabColorService } from '../../../shared/services/tab-color.service';
import { TabService, Tab } from '../../session/tab-service';
import { PlannotatorStateService } from '@/features/plannotator';
import { VSCodeWebStateService } from '@/features/vscode-web/vscode-web-state.service';
import { ClaudeStatusService } from '@/shared/services/claude-status.service';
import { SshForwardsService } from '@/shared/services/ssh-forwards.service';
import { CursorService } from '@/shared/services/cursor.service';
import { TodosService } from '@/features/productivity/todos.service';
import { NavigationProject } from '../../../shared/models/navigation-tree.model';
import { Project } from '@/shared/models/project.model';
import { PendingWorktreeCreationsService } from '@/shared/services/pending-worktree-creations.service';

@Directive({
  selector: 'dialog[trackNativeModal]',
  standalone: true,
  exportAs: 'trackedNativeModal',
})
class MockTrackNativeModalDirective {
  close() {}
  open() {}
}

describe('Sidebar', () => {
  function makeBranch() {
    return {
      name: 'main',
      commit: 'abc123',
      label: 'main',
      current: true,
      isRemote: false,
      hasWorktree: true,
      worktreePath: '/tmp/repo-one-main',
      sessions: [
        {
          id: 11,
          repoId: 1,
          branchName: 'main',
          name: 'Alpha',
          status: 'active' as const,
          hasUnreviewedCompletion: false,
          lastCompletionAt: null,
          lastCompletionKind: null,
          lastStateChangeAt: null,
        },
        {
          id: 12,
          repoId: 1,
          branchName: 'main',
          name: 'Beta',
          status: 'active' as const,
          hasUnreviewedCompletion: false,
          lastCompletionAt: null,
          lastCompletionKind: null,
          lastStateChangeAt: null,
        },
      ],
    };
  }

  const expandedKeys = signal(new Set<string>(['project-1', 'repo-1', 'branch-1-main']));
  const tree = signal<NavigationProject[]>([
    {
      id: 1,
      name: 'Project One',
      repos: [
        {
          id: 1,
          name: 'Repo One',
          path: '/tmp/repo-one',
          branches: [makeBranch()],
        },
      ],
    },
  ]);
  const loading = signal(false);
  const revealProjectId = signal<number | null>(null);
  const highlightedProjectId = signal<number | null>(null);
  const activeSessionId = signal<number | null>(11);
  const tabs = signal<Tab[]>([
    {
      sessionId: 11,
      sessionName: 'Alpha',
      branchName: 'main',
      worktreePath: '/tmp/repo-one-main',
      status: 'active',
      hasUnreviewedCompletion: false,
      lastCompletionAt: null,
      lastCompletionKind: null,
      hasInjectedWorktreeContext: false,
      repoId: 1,
      projectId: 101,
      repoColor: null,
    },
  ]);

  const navigationServiceMock = {
    tree,
    loading,
    revealProjectId,
    highlightedProjectId,
    expandedKeys,
    loadTree: vi.fn(),
    refreshTree: vi.fn(),
    openSession: vi.fn(),
    toggleExpand: vi.fn((key: string) => {
      const next = new Set(expandedKeys());
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      expandedKeys.set(next);
    }),
    isExpanded: vi.fn((key: string) => expandedKeys().has(key)),
    expandKey: vi.fn((key: string) => {
      const next = new Set(expandedKeys());
      next.add(key);
      expandedKeys.set(next);
    }),
    revealProject: vi.fn((projectId: number) => {
      navigationServiceMock.expandKey(`project-${projectId}`);
      revealProjectId.set(projectId);
      highlightedProjectId.set(projectId);
    }),
    clearRevealProject: vi.fn((projectId: number) => {
      if (revealProjectId() === projectId) {
        revealProjectId.set(null);
      }
    }),
    clearHighlightedProject: vi.fn((projectId: number) => {
      if (highlightedProjectId() === projectId) {
        highlightedProjectId.set(null);
      }
    }),
  };

  const sessionsServiceMock = {
    getByRepo: vi.fn(),
    getOne: vi.fn(),
    markReviewed: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateStatus: vi.fn(),
    delete: vi.fn(() => of({})),
    archive: vi.fn(),
    reset: vi.fn(),
    fork: vi.fn(),
    kill: vi.fn(),
  };

  const tabServiceMock = {
    activeSessionId,
    tabs,
    closeTab: vi.fn((sessionId: number) => {
      tabs.set(tabs().filter(tab => tab.sessionId !== sessionId));
      activeSessionId.set(12);
      return 12;
    }),
    getTabsByWorktree: vi.fn(() => []),
    updateTabName: vi.fn(),
  };

  const routerMock = {
    url: '/projects',
    navigate: vi.fn(() => Promise.resolve(true)),
    navigateByUrl: vi.fn(() => Promise.resolve(true)),
  };

  const vscodeWebStateMock = {
    destroyIframe: vi.fn(),
  };

  const worktreesServiceMock = {
    remove: vi.fn(() => of({})),
    removeFromProject: vi.fn(() => of({})),
  };

  const claudeStatusMock = {
    getStatus: vi.fn(() => 'idle'),
    getActivity: vi.fn(() => ({
      activityStatus: 'idle',
      actionKind: null,
      actionLabel: null,
    })),
    getSessionStatus: vi.fn(() => null),
    getSessionCompletion: vi.fn(() => null),
    sessionTitles: signal(new Map<number, string>()).asReadonly(),
  };
  const pendingWorktreeCreationsMock = {
    getByRepo: vi.fn<(repoId: number) => any[]>(() => []),
  };

  const todosCounts = signal(new Map<number, number>());
  const todosServiceMock = {
    getTodos: vi.fn(() => of([])),
    pendingCountsSignal: vi.fn(() => todosCounts()),
    getPendingCount: vi.fn(() => 0),
  };

  beforeEach(async () => {
    vi.useFakeTimers();

    expandedKeys.set(new Set(['project-1', 'repo-1', 'branch-1-main']));
    tree.set([
      {
        id: 1,
        name: 'Project One',
        repos: [
          {
            id: 1,
            name: 'Repo One',
            path: '/tmp/repo-one',
            branches: [makeBranch()],
          },
        ],
      },
    ]);
    loading.set(false);
    revealProjectId.set(null);
    highlightedProjectId.set(null);
    activeSessionId.set(11);
    tabs.set([
      {
        sessionId: 11,
        sessionName: 'Alpha',
        branchName: 'main',
        worktreePath: '/tmp/repo-one-main',
        status: 'active',
        hasUnreviewedCompletion: false,
        lastCompletionAt: null,
        lastCompletionKind: null,
        hasInjectedWorktreeContext: false,
        repoId: 1,
        projectId: 101,
        repoColor: null,
      },
    ]);

    navigationServiceMock.loadTree.mockReset();
    navigationServiceMock.refreshTree.mockReset();
    navigationServiceMock.openSession.mockReset();
    navigationServiceMock.toggleExpand.mockClear();
    navigationServiceMock.isExpanded.mockClear();
    navigationServiceMock.expandKey.mockClear();
    navigationServiceMock.revealProject.mockClear();
    navigationServiceMock.clearRevealProject.mockClear();
    navigationServiceMock.clearHighlightedProject.mockClear();
    sessionsServiceMock.delete.mockReset();
    sessionsServiceMock.delete.mockReturnValue(of({}));
    worktreesServiceMock.remove.mockReset();
    worktreesServiceMock.remove.mockReturnValue(of({}));
    worktreesServiceMock.removeFromProject.mockReset();
    worktreesServiceMock.removeFromProject.mockReturnValue(of({}));
    tabServiceMock.closeTab.mockClear();
    tabServiceMock.updateTabName.mockClear();
    routerMock.navigate.mockClear();
    routerMock.navigateByUrl.mockClear();
    vscodeWebStateMock.destroyIframe.mockClear();
    claudeStatusMock.getStatus.mockReturnValue('idle');
    claudeStatusMock.getActivity.mockReturnValue({
      activityStatus: 'idle',
      actionKind: null,
      actionLabel: null,
    });
    claudeStatusMock.getSessionStatus.mockReturnValue(null);
    claudeStatusMock.getSessionCompletion.mockReturnValue(null);
    pendingWorktreeCreationsMock.getByRepo.mockReset();
    pendingWorktreeCreationsMock.getByRepo.mockReturnValue([]);
    todosServiceMock.getTodos.mockClear();
    todosServiceMock.pendingCountsSignal.mockClear();
    todosServiceMock.getPendingCount.mockClear();

    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
      },
      configurable: true,
    });

    HTMLDialogElement.prototype.showModal ??= vi.fn();
    HTMLDialogElement.prototype.close ??= vi.fn();
    Element.prototype.scrollIntoView ??= vi.fn();

    TestBed.resetTestingModule();
    TestBed.overrideComponent(Sidebar, {
      set: {
        imports: [NgIcon, MockTrackNativeModalDirective],
        schemas: [NO_ERRORS_SCHEMA],
      },
    });

    await TestBed.configureTestingModule({
      imports: [Sidebar],
      schemas: [NO_ERRORS_SCHEMA],
      providers: [
        { provide: Router, useValue: routerMock },
        { provide: NavigationService, useValue: navigationServiceMock },
        { provide: SessionsService, useValue: sessionsServiceMock },
        { provide: WorktreesService, useValue: worktreesServiceMock },
        { provide: TabColorService, useValue: { getRepoColor: vi.fn(() => '#5b7fff') } },
        { provide: TabService, useValue: tabServiceMock },
        { provide: PlannotatorStateService, useValue: { isPanelVisible: vi.fn(() => false) } },
        { provide: VSCodeWebStateService, useValue: vscodeWebStateMock },
        { provide: ClaudeStatusService, useValue: claudeStatusMock },
        { provide: SshForwardsService, useValue: { getByProject: vi.fn(() => of([])) } },
        { provide: CursorService, useValue: { isConfigured: vi.fn(() => true), open: vi.fn(), getSettings: vi.fn(() => null) } },
        { provide: TodosService, useValue: todosServiceMock },
        { provide: PendingWorktreeCreationsService, useValue: pendingWorktreeCreationsMock },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  function createSidebar() {
    const fixture = TestBed.createComponent(Sidebar);
    fixture.detectChanges();
    return fixture;
  }

  function getDeleteTrigger(container: HTMLElement, sessionId: number): HTMLButtonElement | null {
    return container.querySelector(`[data-session-delete-trigger-id="${sessionId}"]`);
  }

  function getDeleteConfirm(container: HTMLElement, sessionId: number): HTMLButtonElement | null {
    return container.querySelector(`[data-session-delete-confirm-id="${sessionId}"]`);
  }

  function getDeleteCancel(container: HTMLElement, sessionId: number): HTMLButtonElement | null {
    return container.querySelector(`[data-session-delete-cancel-id="${sessionId}"]`);
  }

  function getWorktreeRemoveTrigger(container: HTMLElement, worktreePath: string): HTMLButtonElement | null {
    return container.querySelector(`[data-worktree-remove-trigger="${worktreePath}"]`);
  }

  function getWorktreeDeleteTrigger(container: HTMLElement, worktreePath: string): HTMLButtonElement | null {
    return container.querySelector(`[data-worktree-delete-trigger="${worktreePath}"]`);
  }

  it('arms inline confirmation on the first click instead of deleting immediately', () => {
    const fixture = createSidebar();
    const el = fixture.nativeElement as HTMLElement;

    getDeleteTrigger(el, 11)?.click();
    fixture.detectChanges();

    const confirmButton = getDeleteConfirm(el, 11);
    expect(confirmButton).toBeTruthy();
    expect(confirmButton?.disabled).toBe(true);
    expect(sessionsServiceMock.delete).not.toHaveBeenCalled();
  });

  it('opens the add repository wizard for a project without toggling the project row', () => {
    const fixture = createSidebar();
    const component = fixture.componentInstance;
    const event = { stopPropagation: vi.fn() } as unknown as Event;
    const project = tree()[0];

    component.openAddRepoWizard(project, event);

    expect(event.stopPropagation).toHaveBeenCalled();
    expect(navigationServiceMock.expandKey).toHaveBeenCalledWith('project-1');
    expect(navigationServiceMock.toggleExpand).not.toHaveBeenCalled();
    expect(component.addRepoProject()).toBe(project);
  });

  it('refreshes and reveals the project after adding repositories', () => {
    const fixture = createSidebar();
    const component = fixture.componentInstance;
    component.addRepoProject.set(tree()[0]);

    component.handleRepoAdded({ id: 1, name: 'Project One', createdAt: '', updatedAt: '' });

    expect(component.addRepoProject()).toBeNull();
    expect(navigationServiceMock.refreshTree).toHaveBeenCalled();
    expect(navigationServiceMock.revealProject).toHaveBeenCalledWith(1);
  });

  it('requires the 300ms guard before confirming delete', () => {
    const fixture = createSidebar();
    const el = fixture.nativeElement as HTMLElement;

    getDeleteTrigger(el, 11)?.click();
    fixture.detectChanges();

    const confirmButtonBeforeDelay = getDeleteConfirm(el, 11);
    expect(confirmButtonBeforeDelay?.disabled).toBe(true);
    confirmButtonBeforeDelay?.click();
    expect(sessionsServiceMock.delete).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    fixture.detectChanges();

    const confirmButtonAfterDelay = getDeleteConfirm(el, 11);
    expect(confirmButtonAfterDelay?.disabled).toBe(false);
    confirmButtonAfterDelay?.click();

    expect(sessionsServiceMock.delete).toHaveBeenCalledOnce();
    expect(sessionsServiceMock.delete).toHaveBeenCalledWith(11);
  });

  it('keeps only one session armed at a time and allows explicit cancel', () => {
    const fixture = createSidebar();
    const el = fixture.nativeElement as HTMLElement;

    getDeleteTrigger(el, 11)?.click();
    fixture.detectChanges();
    expect(getDeleteConfirm(el, 11)).toBeTruthy();

    getDeleteTrigger(el, 12)?.click();
    fixture.detectChanges();
    expect(getDeleteConfirm(el, 11)).toBeFalsy();
    expect(getDeleteConfirm(el, 12)).toBeTruthy();

    getDeleteCancel(el, 12)?.click();
    fixture.detectChanges();
    expect(getDeleteConfirm(el, 12)).toBeFalsy();
    expect(getDeleteTrigger(el, 12)).toBeTruthy();
  });

  it('clears the armed state when clicking outside the delete controls', () => {
    const fixture = createSidebar();
    const el = fixture.nativeElement as HTMLElement;

    getDeleteTrigger(el, 11)?.click();
    fixture.detectChanges();
    expect(getDeleteConfirm(el, 11)).toBeTruthy();

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    fixture.detectChanges();

    expect(getDeleteConfirm(el, 11)).toBeFalsy();
    expect(getDeleteTrigger(el, 11)).toBeTruthy();
  });

  it('shows an inline loading state and blocks duplicate delete requests while deleting', () => {
    const deleteSubject = new Subject<{}>();
    sessionsServiceMock.delete.mockReturnValue(deleteSubject.asObservable());

    const fixture = createSidebar();
    const el = fixture.nativeElement as HTMLElement;

    getDeleteTrigger(el, 11)?.click();
    vi.advanceTimersByTime(300);
    fixture.detectChanges();

    getDeleteConfirm(el, 11)?.click();
    fixture.detectChanges();

    const loadingButton = getDeleteConfirm(el, 11);
    expect(loadingButton?.textContent).toContain('Deleting');
    expect(loadingButton?.disabled).toBe(true);

    loadingButton?.click();
    expect(sessionsServiceMock.delete).toHaveBeenCalledOnce();

    deleteSubject.next({});
    deleteSubject.complete();
  });

  it('preserves tab closing, iframe cleanup, and navigation on successful delete', () => {
    sessionsServiceMock.delete.mockReturnValue(of({}));
    tabServiceMock.closeTab.mockImplementation((sessionId: number) => {
      tabs.set([]);
      activeSessionId.set(12);
      return 12;
    });

    const fixture = createSidebar();
    const el = fixture.nativeElement as HTMLElement;

    getDeleteTrigger(el, 11)?.click();
    vi.advanceTimersByTime(300);
    fixture.detectChanges();
    getDeleteConfirm(el, 11)?.click();

    expect(tabServiceMock.closeTab).toHaveBeenCalledWith(11);
    expect(vscodeWebStateMock.destroyIframe).toHaveBeenCalledWith('101:/tmp/repo-one-main');
    expect(routerMock.navigate).toHaveBeenCalledWith(['/sessions', 12], { replaceUrl: true });
    expect(navigationServiceMock.refreshTree).toHaveBeenCalledOnce();
  });

  it('renders distinct remove-from-project and delete-worktree actions for worktree branches', () => {
    const fixture = createSidebar();
    const el = fixture.nativeElement as HTMLElement;

    expect(getWorktreeRemoveTrigger(el, '/tmp/repo-one-main')).toBeTruthy();
    expect(getWorktreeDeleteTrigger(el, '/tmp/repo-one-main')).toBeTruthy();
  });

  it('renders a pending worktree branch row while creation is in progress', () => {
    pendingWorktreeCreationsMock.getByRepo.mockImplementation(((repoId: number) => (
      repoId === 1
        ? [{
          jobId: 'job-1',
          repoId: 1,
          branchName: 'feature',
          worktreePath: '/tmp/repo-one/.worktrees/feature',
          status: 'running',
          autoCreateSession: false,
        }]
        : []
    )) as any);

    const fixture = createSidebar();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-pending-worktree-branch="feature"]')?.textContent).toContain('Creating');
  });

  it('suppresses a duplicate pending branch when the real branch is already in the tree', () => {
    tree.set([
      {
        id: 1,
        name: 'Project One',
        repos: [
          {
            id: 1,
            name: 'Repo One',
            path: '/tmp/repo-one',
            branches: [
              makeBranch(),
              {
                ...makeBranch(),
                name: 'feature',
                label: 'feature',
                current: false,
                worktreePath: '/tmp/repo-one/.worktrees/feature',
                sessions: [{
                  id: 99,
                  repoId: 1,
                  branchName: 'feature',
                  name: 'Feature Session',
                  status: 'active' as const,
                  hasUnreviewedCompletion: false,
                  lastCompletionAt: null,
                  lastCompletionKind: null,
                  lastStateChangeAt: null,
                }],
              },
            ],
          },
        ],
      },
    ]);
    expandedKeys.set(new Set(['project-1', 'repo-1', 'branch-1-main', 'branch-1-feature']));
    pendingWorktreeCreationsMock.getByRepo.mockReturnValue([{
      jobId: 'job-1',
      repoId: 1,
      branchName: 'feature',
      worktreePath: '/tmp/repo-one/.worktrees/feature',
      status: 'running',
      autoCreateSession: false,
    }] as any);

    const fixture = createSidebar();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelectorAll('[data-pending-worktree-branch="feature"]')).toHaveLength(0);
    expect(el.textContent).toContain('Feature Session');
  });

  it('shows an opening state and ignores duplicate worktree sheet opens', () => {
    const fixture = createSidebar();
    const component = fixture.componentInstance;
    const repo = tree()[0].repos[0];
    const branch = {
      ...makeBranch(),
      name: 'feature',
      label: 'feature',
      hasWorktree: false,
      worktreePath: null,
      sessions: [],
    };
    const worktreeSheet = { open: vi.fn() };
    component.worktreeSheet = worktreeSheet as any;

    component.openCreateWorktree(repo, branch);

    expect(component.openingWorktreeBranchKey()).toBe('1:feature');
    expect(component.isOpeningWorktree(repo, branch)).toBe(true);

    component.openCreateWorktree(repo, { ...branch, name: 'other', label: 'other' });
    vi.advanceTimersByTime(0);

    expect(worktreeSheet.open).toHaveBeenCalledOnce();
    expect(worktreeSheet.open).toHaveBeenCalledWith(1, 'feature', '/tmp/repo-one', 'Repo One', false);
    expect(component.openingWorktreeBranchKey()).toBeNull();
  });

  it('removes a worktree from the project without calling destructive worktree deletion', () => {
    tabServiceMock.getTabsByWorktree.mockReturnValue([
      {
        sessionId: 11,
        sessionName: 'Alpha',
        branchName: 'main',
        worktreePath: '/tmp/repo-one-main',
        status: 'active',
        hasUnreviewedCompletion: false,
        lastCompletionAt: null,
        lastCompletionKind: null,
        lastStateChangeAt: null,
        hasInjectedWorktreeContext: false,
        repoId: 1,
        projectId: 101,
        repoColor: null,
      },
    ] as any);
    tabServiceMock.closeTab.mockImplementation((sessionId: number) => {
      tabs.set([]);
      activeSessionId.set(12);
      return 12;
    });

    const fixture = createSidebar();
    const component = fixture.componentInstance;

    component.removeFromProjectRepoId.set(1);
    component.removeFromProjectPath.set('/tmp/repo-one-main');
    component.confirmRemoveFromProject();

    expect(worktreesServiceMock.removeFromProject).toHaveBeenCalledWith(1, '/tmp/repo-one-main');
    expect(worktreesServiceMock.remove).not.toHaveBeenCalled();
    expect(tabServiceMock.closeTab).toHaveBeenCalledWith(11);
    expect(vscodeWebStateMock.destroyIframe).toHaveBeenCalledWith('101:/tmp/repo-one-main');
    expect(routerMock.navigate).toHaveBeenCalledWith(['/sessions', 12], { replaceUrl: true });
    expect(navigationServiceMock.refreshTree).toHaveBeenCalledOnce();
  });

  it('opens the shared project wizard from the sidebar', () => {
    const fixture = createSidebar();
    const component = fixture.componentInstance;

    component.openCreateProjectWizard();

    expect(component.showCreateWizard()).toBe(true);
  });

  it('renders an info link to the app info page', () => {
    const fixture = createSidebar();
    const element = fixture.nativeElement as HTMLElement;
    const infoLink = element.querySelector('[aria-label="Open app info"]');

    expect(infoLink?.getAttribute('routerLink')).toBe('/info');
  });

  it('renders the running activity indicator for a working Claude session', () => {
    claudeStatusMock.getStatus.mockImplementation(((sessionId: number) => sessionId === 11 ? 'running' : 'idle') as any);
    claudeStatusMock.getActivity.mockImplementation(((sessionId: number) => sessionId === 11
      ? { activityStatus: 'running', actionKind: null, actionLabel: null }
      : { activityStatus: 'idle', actionKind: null, actionLabel: null }) as any);

    const fixture = createSidebar();
    const el = fixture.nativeElement as HTMLElement;
    const row = el.querySelector('[data-session-row-id="11"]');
    const dot = row?.querySelector('.sidebar-status-dot');

    expect(dot?.classList.contains('status-running')).toBe(true);
    expect(dot?.getAttribute('aria-label')).toBe('Claude is working');
  });

  it('renders an action chip for pending permission prompts', () => {
    claudeStatusMock.getStatus.mockImplementation(((sessionId: number) => sessionId === 11 ? 'waiting' : 'idle') as any);
    claudeStatusMock.getActivity.mockImplementation(((sessionId: number) => sessionId === 11
      ? { activityStatus: 'waiting', actionKind: 'permission', actionLabel: 'Permission needed' }
      : { activityStatus: 'idle', actionKind: null, actionLabel: null }) as any);

    const fixture = createSidebar();
    const el = fixture.nativeElement as HTMLElement;
    const row = el.querySelector('[data-session-row-id="11"]');

    expect(row?.querySelector('.sidebar-status-dot')?.classList.contains('status-waiting')).toBe(true);
    expect(row?.querySelector('.sidebar-action-chip')?.textContent).toContain('Permission needed');
  });

  it('renders an action chip for pending user input prompts', () => {
    claudeStatusMock.getStatus.mockImplementation(((sessionId: number) => sessionId === 11 ? 'waiting' : 'idle') as any);
    claudeStatusMock.getActivity.mockImplementation(((sessionId: number) => sessionId === 11
      ? { activityStatus: 'waiting', actionKind: 'user_input', actionLabel: 'Input needed' }
      : { activityStatus: 'idle', actionKind: null, actionLabel: null }) as any);

    const fixture = createSidebar();
    const el = fixture.nativeElement as HTMLElement;
    const row = el.querySelector('[data-session-row-id="11"]');

    expect(row?.querySelector('.sidebar-action-chip')?.textContent).toContain('Input needed');
  });

  it('keeps idle sessions visually quiet without an action chip', () => {
    const fixture = createSidebar();
    const el = fixture.nativeElement as HTMLElement;
    const row = el.querySelector('[data-session-row-id="11"]');

    expect(row?.querySelector('.sidebar-status-dot')?.classList.contains('status-idle')).toBe(true);
    expect(row?.querySelector('.sidebar-action-chip')).toBeNull();
  });

  it('navigates to the new project after wizard completion', () => {
    const fixture = createSidebar();
    const component = fixture.componentInstance;
    const project: Project = {
      id: 14,
      name: 'New Project',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    };

    component.handleProjectCreated(project);

    expect(component.showCreateWizard()).toBe(false);
    expect(routerMock.navigate).toHaveBeenCalledWith(['/projects', 14]);
  });

  it('formats the live session last state-change time using claude status first', () => {
    claudeStatusMock.getSessionCompletion.mockReturnValue({
      hasUnreviewedCompletion: false,
      lastCompletionAt: null,
      lastCompletionKind: null,
      lastStateChangeAt: '2024-01-01T11:55:00.000Z',
    } as any);
    vi.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

    const fixture = createSidebar();
    const component = fixture.componentInstance;
    const session = tree()[0].repos[0].branches[0].sessions[0];

    expect(component.getSessionLastStateChangeLabel(session)).toBe('5m');
    expect(component.getSessionLastStateChangeTooltip(session)).toContain('2024');
  });
});
