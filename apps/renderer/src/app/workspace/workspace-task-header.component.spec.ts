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
      selectedTask: signal({ id: 11, name: 'A task', branchName: 'work', projectId: 1, projectRepositoryCount: 1, state: 'ready' }),
      taskSelection: signal({ scopeId: 'scope', taskId: 11 }), selectedTaskStage: signal('active'),
      projects: signal([]), selectedCreation: signal(null), busy: signal(false), offline: signal(false),
      commitPanelAvailable: signal(false), machine: signal({ name: 'This machine' }),
    };
    TestBed.configureTestingModule({ providers: [
      { provide: WorkspaceStore, useValue: store }, { provide: ELEVENEX_BRIDGE, useValue: {} },
    ] });
    TestBed.overrideComponent(WorkspaceTaskHeaderComponent, { set: { providers: [{ provide: WorkspaceTaskGitService, useValue: git }] } });
    const fixture = TestBed.createComponent(WorkspaceTaskHeaderComponent);
    fixture.detectChanges();
    return { fixture, git, store, root: fixture.nativeElement as HTMLElement };
  }

  it('keeps delayed loading, behind and error feedback inside the metadata row with reachable actions', async () => {
    const { fixture, git, root } = setup();
    await fixture.whenStable();
    const header = root.querySelector('ex-task-header header');
    const metadataRow = root.querySelector('.metadata')?.parentElement;
    expect(header).not.toBeNull();
    expect(metadataRow?.textContent).toContain('Checking Git status');
    git.loading.set(false);
    git.summary.set({ ...behind, behind: 37 });
    git.state.set({ files: 0 });
    fixture.detectChanges(); await fixture.whenStable();
    const pull = root.querySelector<HTMLButtonElement>('button.pull');
    expect(pull?.closest('.row')).toBe(metadataRow);
    expect(pull?.getAttribute('aria-label')).toBe('Pull 37 commits');
    expect(pull?.getAttribute('aria-description')).toContain(`From ${upstream} into ${branch}.`);
    pull?.click();
    expect(git.perform).toHaveBeenCalledWith({ type: 'sync' });

    const message = 'Git status could not be loaded. Refresh to check the current task.';
    git.error.set(message);
    fixture.detectChanges(); await fixture.whenStable();
    const alert = root.querySelector('[role="alert"]');
    expect(alert?.closest('.row')).toBe(metadataRow);
    expect(alert?.textContent).toContain(message);
    alert?.querySelector<HTMLButtonElement>('button')?.click();
    expect(git.refresh).toHaveBeenCalledOnce();
    expect(root.querySelector('ex-task-header header')).toBe(header);
    expect(header?.querySelectorAll('.row')).toHaveLength(2);
    expect(root.querySelector('.git-notice')).toBeNull();
    fixture.destroy();
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
