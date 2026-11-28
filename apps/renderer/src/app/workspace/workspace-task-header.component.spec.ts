import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { WorkspaceTaskHeaderComponent } from './workspace-task-header.component';
import { WorkspaceStore } from './workspace.store';
import { WorkspaceTaskGitService } from './workspace-task-git.service';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import type { WorkspaceGitAction, WorkspaceGitSummary } from '@elevenex/shared';
import type { GitState } from '../tasks';

describe('Workspace task header status', () => {
  const upstream = 'backup/team/release/billing-exports';
  const branch = 'feature/billing-exports';
  const behind = { taskId: 11, branch, upstream, ahead: 0, behind: 1, files: 2, additions: 10, deletions: 3, conflicted: false } satisfies WorkspaceGitSummary;
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });

  function setup() {
    const git = {
      summary: signal<WorkspaceGitSummary | null>(null), state: signal<GitState | undefined>(undefined),
      error: signal<string | null>(null), pullError: signal<string | null>(null),
      loading: signal(true), busy: signal<WorkspaceGitAction['type'] | null>(null),
      uncertain: signal(false), commitPreview: signal(null), refresh: vi.fn(), perform: vi.fn(),
    };
    const store = {
      selectedTask: signal({ id: 11, name: 'A task', branchName: 'work', projectId: 1, projectRepositoryCount: 1, state: 'ready', temporary: false }),
      taskSelection: signal({ scopeId: 'scope', taskId: 11 }), selectedTaskStage: signal('active'),
      activeProject: signal('all'), projects: signal([{ id: '1', name: 'Project' }]),
      selectedCreation: signal(null), busy: signal(false), offline: signal(false),
      commitPanelAvailable: signal(false), machine: signal({ name: 'This machine' }),
      mutationUncertain: signal(false), selectedTaskHasActivity: signal(false), error: signal<string | null>(null),
      keepTaskOpen: vi.fn(), closeTask: vi.fn(),
    };
    const bridge = {
      writeClipboardText: vi.fn(async () => {}),
      workspaceClosePreview: vi.fn(async () => ({ ok: true, value: { running: 0, unpushed: 0, uncommitted: 0, terminals: 0, actions: 0 } })),
    };
    TestBed.configureTestingModule({ providers: [
      { provide: WorkspaceStore, useValue: store }, { provide: ELEVENEX_BRIDGE, useValue: bridge },
    ] });
    TestBed.overrideComponent(WorkspaceTaskHeaderComponent, { set: { providers: [{ provide: WorkspaceTaskGitService, useValue: git }] } });
    const fixture = TestBed.createComponent(WorkspaceTaskHeaderComponent);
    fixture.detectChanges();
    return { fixture, git, store, bridge, root: fixture.nativeElement as HTMLElement };
  }

  it('groups branch and temporary-task actions in one menu and keeps copy available in closed history', async () => {
    const { fixture, git, store, bridge, root } = setup();
    store.selectedTask.update(task => ({ ...task, temporary: true }));
    git.summary.set(behind);
    fixture.detectChanges();
    const trigger = root.querySelector<HTMLButtonElement>('button[aria-label="Task actions"]')!;
    const items = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menu"][aria-label="Task actions"] [role="menuitem"]')];
    expect(root.querySelector('.close-task')).toBeNull();
    trigger.click();
    fixture.detectChanges();
    expect(items().map(item => item.textContent?.trim())).toEqual(['Rename branch', 'Copy branch name', 'Keep open', 'Close task']);
    items()[1]!.click();
    await fixture.whenStable();
    expect(bridge.writeClipboardText).toHaveBeenCalledExactlyOnceWith(branch);
    expect(root.textContent).toContain('Branch name copied');
    trigger.click();
    fixture.detectChanges();
    items()[2]!.click();
    expect(store.keepTaskOpen).toHaveBeenCalledOnce();

    store.selectedTaskStage.set('closed');
    fixture.detectChanges();
    trigger.click();
    fixture.detectChanges();
    expect(items().map(item => item.textContent?.trim())).toEqual(['Copy branch name']);
  });

  it('offers a labeled close shortcut for a clean published branch and still checks the authoritative close preview', async () => {
    const { fixture, git, store, bridge, root } = setup();
    const published = { ...behind, upstream: `backup/${branch}`, behind: 0, files: 0, additions: 0, deletions: 0 };
    git.state.set({ files: 0 });
    git.loading.set(false);
    for (const summary of [
      { ...published, files: 1 },
      { ...published, ahead: 1 },
      { ...published, behind: 1 },
      { ...published, conflicted: true },
      { ...published, upstream: 'origin/main' },
      { ...published, upstream: null },
      { ...published, taskId: 12 },
    ]) {
      git.summary.set(summary);
      fixture.detectChanges();
      expect(root.querySelector('.close-task')).toBeNull();
    }
    git.summary.set(published);
    store.selectedTaskHasActivity.set(true);
    fixture.detectChanges();
    expect(root.querySelector('.close-task')).toBeNull();
    store.selectedTaskHasActivity.set(false);
    fixture.detectChanges();
    const close = root.querySelector<HTMLButtonElement>('.close-task')!;
    expect(close.textContent?.trim()).toBe('Close task');
    expect(root.querySelector('.stat.quiet')?.textContent?.trim() ?? '').toBe('');
    close.click();
    await fixture.whenStable();
    expect(bridge.workspaceClosePreview).toHaveBeenCalledExactlyOnceWith('scope', 11);
    expect(store.closeTask).toHaveBeenCalledOnce();
    store.offline.set(true);
    fixture.detectChanges();
    expect(root.querySelector('.close-task')).toBeNull();
  });

  it('keeps delayed loading, behind and error feedback inside the task toolbar with reachable actions', async () => {
    const { fixture, git, root } = setup();
    await fixture.whenStable();
    const header = root.querySelector('ex-task-header header');
    const row = header?.querySelector('.row');
    expect(header).not.toBeNull();
    expect(row?.textContent).toContain('Checking Git status');
    expect(row?.querySelector('[aria-label="Link PR or ticket"]')).toBeNull();
    git.loading.set(false);
    git.summary.set({ ...behind, behind: 37 });
    git.state.set({ files: 0 });
    fixture.detectChanges(); await fixture.whenStable();
    const pull = root.querySelector<HTMLButtonElement>('button.pull');
    expect(pull?.closest('.row')).toBe(row);
    expect(pull?.getAttribute('aria-label')).toBe('Pull 37 commits');
    expect(pull?.getAttribute('aria-description')).toContain(`From ${upstream} into ${branch}.`);
    pull?.click();
    expect(git.perform).toHaveBeenCalledWith({ type: 'sync' });

    const message = 'Git status could not be loaded. Refresh to check the current task.';
    git.error.set(message);
    fixture.detectChanges(); await fixture.whenStable();
    const alert = root.querySelector('[role="alert"]');
    expect(alert?.closest('.row')).toBe(row);
    expect(alert?.textContent).toContain(message);
    alert?.querySelector<HTMLButtonElement>('button')?.click();
    expect(git.refresh).toHaveBeenCalledOnce();
    expect(root.querySelector('ex-task-header header')).toBe(header);
    expect(header?.querySelectorAll('.row')).toHaveLength(1);
    fixture.destroy();
  });

  it('shows project identity when the rail is in All projects', async () => {
    const { fixture, store, root } = setup();
    await fixture.whenStable();
    expect(root.querySelector('ex-task-header ex-project-mark')).not.toBeNull();
    store.activeProject.set('1');
    fixture.detectChanges();
    expect(root.querySelector('ex-task-header ex-project-mark')).toBeNull();
  });

  it('shows progress on the same control, disables Git writes, and keeps review reachable', async () => {
    const { fixture, git, root } = setup();
    git.loading.set(false);
    git.summary.set(behind);
    git.state.set({ files: 2, add: 10, del: 3 });
    const panelToggle = vi.fn();
    fixture.componentInstance.panelToggle.subscribe(panelToggle);
    fixture.detectChanges(); await fixture.whenStable();

    const pull = root.querySelector<HTMLButtonElement>('button.pull')!;
    expect(pull.getAttribute('aria-label')).toBe('Pull 1 commit');
    expect(pull.getAttribute('aria-disabled')).toBe('false');
    git.busy.set('sync');
    fixture.detectChanges(); await fixture.whenStable();
    expect(root.querySelector('button.pull')).toBe(pull);
    expect(pull.getAttribute('aria-busy')).toBe('true');
    pull.click();
    expect(git.perform).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLButtonElement>('ex-git-bar .primary')?.disabled).toBe(true);
    root.querySelector<HTMLButtonElement>('ex-git-bar .stat-slot button')?.click();
    expect(panelToggle).toHaveBeenCalledOnce();
  });

  it('explains offline, divergent and conflicted status without sending a pull', async () => {
    const { fixture, git, store, root } = setup();
    git.loading.set(false);
    git.summary.set(behind);
    store.offline.set(true);
    fixture.detectChanges(); await fixture.whenStable();
    const pull = root.querySelector<HTMLButtonElement>('button.pull')!;
    expect(pull.getAttribute('aria-description')).toContain('This machine');
    pull.click();

    store.offline.set(false);
    git.summary.set({ ...behind, ahead: 2 });
    fixture.detectChanges(); await fixture.whenStable();
    expect(pull.getAttribute('aria-description')).toContain('1 commit behind and 2 ahead');
    pull.click();

    git.summary.set({ ...behind, conflicted: true });
    fixture.detectChanges(); await fixture.whenStable();
    expect(pull.getAttribute('aria-description')).toContain('Resolve the worktree conflicts');
    pull.click();
    expect(git.perform).not.toHaveBeenCalled();

    git.summary.set({ ...behind, upstream: null, behind: 0 });
    fixture.detectChanges(); await fixture.whenStable();
    expect(root.querySelector('button.pull')).toBeNull();
  });

  it('keeps the review and commit controls after a confirmed pull rejection', async () => {
    const { fixture, git, root } = setup();
    git.loading.set(false);
    git.summary.set(behind);
    git.state.set({ files: 2, add: 10, del: 3 });
    git.pullError.set('Could not fast-forward the task branch.');
    fixture.detectChanges(); await fixture.whenStable();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Could not fast-forward');
    expect(root.querySelector('ex-git-bar .stat-slot button')).not.toBeNull();
    expect(root.querySelector<HTMLButtonElement>('ex-git-bar .primary')?.disabled).toBe(false);
    root.querySelector<HTMLButtonElement>('button[aria-label="Refresh Git status"]')?.click();
    expect(git.refresh).toHaveBeenCalledOnce();
  });
});
