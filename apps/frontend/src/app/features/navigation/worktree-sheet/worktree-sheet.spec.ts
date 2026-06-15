import { Component, Directive, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TestBed } from '@angular/core/testing';
import { NgIcon } from '@ng-icons/core';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of, Subject } from 'rxjs';
import { WorktreeSheet } from './worktree-sheet';
import { WorktreesService } from '@/shared/services/worktrees.service';
import { SessionsService } from '@/shared/services/sessions.service';
import { NavigationService } from '@/shared/services/navigation.service';
import { WorktreePoolItem } from '@/shared/models/worktree.model';

vi.mock('ngx-sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

@Directive({
  selector: 'dialog[trackNativeModal]',
  standalone: true,
  exportAs: 'trackedNativeModal',
})
class MockTrackNativeModalDirective {
  close = vi.fn();
  open = vi.fn();
}

@Component({
  selector: 'app-path-autocomplete-input',
  standalone: true,
  template: '',
})
class MockPathAutocompleteInputComponent {
  readonly value = input('');
  readonly preferredStartDirectory = input<string | undefined>(undefined);
  readonly pathKind = input<'file' | 'directory' | 'either'>('either');
  readonly placeholder = input('');
  readonly valueChange = output<string>();
}

function poolItem(patch: Partial<WorktreePoolItem> = {}): WorktreePoolItem {
  return {
    id: 11,
    repoRootPath: '/tmp/repo',
    path: '/tmp/repo-feature',
    name: 'feature',
    createdFromRef: 'feature',
    currentBranch: 'feature',
    head: 'abc',
    isDetached: false,
    isBare: false,
    isLocked: false,
    lockReason: null,
    isMissing: false,
    isDirty: false,
    hasConflicts: false,
    runningAgentCount: 0,
    owner: null,
    projectWorkspace: null,
    ...patch,
  };
}

describe('WorktreeSheet', () => {
  const worktreesServiceMock = {
    getPoolByRepo: vi.fn(),
    getPoolByRepoStream: vi.fn(),
    createPool: vi.fn(),
    linkPool: vi.fn(),
  };
  const sessionsServiceMock = {
    create: vi.fn(),
  };
  const navigationServiceMock = {
    refreshTree: vi.fn(),
    openSession: vi.fn(),
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    worktreesServiceMock.getPoolByRepo.mockReset();
    worktreesServiceMock.getPoolByRepoStream.mockReset();
    worktreesServiceMock.createPool.mockReset();
    worktreesServiceMock.linkPool.mockReset();
    sessionsServiceMock.create.mockReset();
    navigationServiceMock.refreshTree.mockReset();
    navigationServiceMock.openSession.mockReset();
    worktreesServiceMock.getPoolByRepo.mockReturnValue(of([]));
    worktreesServiceMock.getPoolByRepoStream.mockReturnValue(of([]));
    worktreesServiceMock.linkPool.mockReturnValue(of({ id: 99, repoId: 7 }));
    sessionsServiceMock.create.mockReturnValue(of({ id: 123 }));

    TestBed.resetTestingModule();
    TestBed.overrideComponent(WorktreeSheet, {
      set: {
        imports: [
          FormsModule,
          NgIcon,
          MockTrackNativeModalDirective,
          MockPathAutocompleteInputComponent,
        ],
      },
    });

    await TestBed.configureTestingModule({
      imports: [WorktreeSheet],
      providers: [
        { provide: WorktreesService, useValue: worktreesServiceMock },
        { provide: SessionsService, useValue: sessionsServiceMock },
        { provide: NavigationService, useValue: navigationServiceMock },
      ],
    }).compileComponents();
  });

  it('opens with a repo-scoped pool and default create path', () => {
    worktreesServiceMock.getPoolByRepoStream.mockReturnValue(of([poolItem()]));
    const fixture = TestBed.createComponent(WorktreeSheet);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    const dialog = component.dialogRef as unknown as MockTrackNativeModalDirective;
    component.open(7, 'feature', '/tmp/repos/path-basename', 'repo-one');

    expect(component.createName()).toBe('repo-one 1');
    expect(component.createPath()).toBe('/tmp/repos/.worktrees/repo-one/repo-one-1');
    expect(component.showCreateForm()).toBe(false);
    expect(component.pool()).toHaveLength(1);
    expect(worktreesServiceMock.getPoolByRepoStream).toHaveBeenCalledWith(7);
    expect(dialog.open).toHaveBeenCalledOnce();
  });

  it('opens the create form with the next available repo-numbered name', () => {
    worktreesServiceMock.getPoolByRepoStream.mockReturnValue(of([
      poolItem({ name: 'repo-one 1', path: '/tmp/repos/.worktrees/repo-one/repo-one-1' }),
    ]));
    const fixture = TestBed.createComponent(WorktreeSheet);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    component.open(7, 'feature', '/tmp/repos/path-basename', 'repo-one');
    component.openCreateForm();

    expect(component.showCreateForm()).toBe(true);
    expect(component.createName()).toBe('repo-one 2');
    expect(component.createPath()).toBe('/tmp/repos/.worktrees/repo-one/repo-one-2');
  });

  it('creates a pool worktree and links it to the current project', () => {
    const created = poolItem({ id: 22 });
    worktreesServiceMock.createPool.mockReturnValue(of(created));
    const fixture = TestBed.createComponent(WorktreeSheet);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    component.repoId.set(7);
    component.branchName.set('feature');
    component.createName.set('feature');
    component.createPath.set('/tmp/repo-feature');

    component.createAndLink();

    expect(worktreesServiceMock.createPool).toHaveBeenCalledWith(7, {
      name: 'feature',
      path: '/tmp/repo-feature',
      startPoint: 'feature',
    });
    expect(worktreesServiceMock.linkPool).toHaveBeenCalledWith(7, 22, {
      workspaceName: 'feature',
      branchName: 'feature',
      confirmTakeover: false,
      confirmStash: false,
      applyPendingStash: false,
    });
    expect(navigationServiceMock.refreshTree).toHaveBeenCalledOnce();
  });

  it('ignores duplicate creates while creation is in progress', () => {
    const createSubject = new Subject<WorktreePoolItem>();
    worktreesServiceMock.createPool.mockReturnValue(createSubject.asObservable());
    const fixture = TestBed.createComponent(WorktreeSheet);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    component.repoId.set(7);
    component.branchName.set('feature');
    component.createName.set('feature');
    component.createPath.set('/tmp/repo-feature');

    component.createAndLink();
    component.createAndLink();

    expect(worktreesServiceMock.createPool).toHaveBeenCalledOnce();
  });

  it('derives takeover and stash flags when linking a stolen, dirty worktree', () => {
    const item = poolItem({
      isDirty: true,
      runningAgentCount: 2,
      owner: {
        projectId: 2,
        projectName: 'Other',
        repoId: 8,
        workspaceId: 55,
        workspaceName: 'feature',
        linkStatus: 'linked',
      },
    });
    const fixture = TestBed.createComponent(WorktreeSheet);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    component.repoId.set(7);
    component.branchName.set('feature');
    component.link(item);

    expect(worktreesServiceMock.linkPool).toHaveBeenCalledWith(7, 11, {
      workspaceName: 'feature',
      branchName: 'feature',
      confirmTakeover: true,
      confirmStash: true,
      applyPendingStash: false,
    });
  });

  it('opens an inline confirmation before linking a worktree with side effects', () => {
    const item = poolItem({
      isDirty: true,
      owner: {
        projectId: 2,
        projectName: 'Other',
        repoId: 8,
        workspaceId: 55,
        workspaceName: 'feature',
        linkStatus: 'linked',
      },
    });
    const fixture = TestBed.createComponent(WorktreeSheet);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    component.repoId.set(7);
    component.branchName.set('feature');
    component.pool.set([item]);

    const entry = component.visiblePool()[0];
    component.requestAction(entry);

    // First click only opens the confirmation panel, it does not link yet.
    expect(component.confirmingId()).toBe(item.id);
    expect(worktreesServiceMock.linkPool).not.toHaveBeenCalled();

    component.confirmLink(item);

    expect(component.confirmingId()).toBeNull();
    expect(worktreesServiceMock.linkPool).toHaveBeenCalledWith(7, 11, {
      workspaceName: 'feature',
      branchName: 'feature',
      confirmTakeover: true,
      confirmStash: true,
      applyPendingStash: false,
    });
  });

  it('links a clean, available worktree immediately without confirmation', () => {
    const item = poolItem();
    const fixture = TestBed.createComponent(WorktreeSheet);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    component.repoId.set(7);
    component.branchName.set('feature');
    component.pool.set([item]);

    const entry = component.visiblePool()[0];
    component.requestAction(entry);

    expect(component.confirmingId()).toBeNull();
    expect(worktreesServiceMock.linkPool).toHaveBeenCalledWith(7, 11, {
      workspaceName: 'feature',
      branchName: 'feature',
      confirmTakeover: false,
      confirmStash: false,
      applyPendingStash: false,
    });
  });
});
