import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { WorkspaceTaskHeaderComponent } from './workspace-task-header.component';
import { WorkspaceStore } from './workspace.store';
import { WorkspaceTaskGitService } from './workspace-task-git.service';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import type { WorkspaceGitSummary } from '@elevenex/shared';
import type { GitState } from '../tasks';

describe('Workspace task header status', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });

  function setup() {
    const git = {
      summary: signal<WorkspaceGitSummary | null>(null), state: signal<GitState | undefined>(undefined),
      error: signal<string | null>(null), loading: signal(true), busy: signal(null),
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
    return { fixture, git, root: fixture.nativeElement as HTMLElement };
  }

  it('keeps delayed loading, behind and error feedback inside the metadata row with reachable actions', async () => {
    const { fixture, git, root } = setup();
    await fixture.whenStable();
    const header = root.querySelector('ex-task-header header');
    const metadataRow = root.querySelector('.metadata')?.parentElement;
    expect(header).not.toBeNull();
    expect(metadataRow?.textContent).toContain('Checking Git status');
    git.loading.set(false);
    git.summary.set({ taskId: 11, branch: 'work', upstream: 'origin/main', ahead: 0, behind: 37, files: 0, additions: 0, deletions: 0, conflicted: false });
    git.state.set({ files: 0 });
    fixture.detectChanges(); await fixture.whenStable();
    const sync = root.querySelector<HTMLButtonElement>('button.sync');
    expect(sync?.closest('.row')).toBe(metadataRow);
    expect(sync?.getAttribute('aria-label')).toContain('37 commits behind');
    sync?.click();
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
});
