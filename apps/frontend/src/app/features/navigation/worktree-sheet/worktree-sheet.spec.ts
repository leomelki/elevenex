import { Component, Directive, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TestBed } from '@angular/core/testing';
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
    worktreesServiceMock.createPool.mockReset();
    worktreesServiceMock.linkPool.mockReset();
    sessionsServiceMock.create.mockReset();
    navigationServiceMock.refreshTree.mockReset();
    navigationServiceMock.openSession.mockReset();
    worktreesServiceMock.getPoolByRepo.mockReturnValue(of([]));
    worktreesServiceMock.linkPool.mockReturnValue(of({ id: 99, repoId: 7 }));
    sessionsServiceMock.create.mockReturnValue(of({ id: 123 }));

    TestBed.resetTestingModule();
    TestBed.overrideComponent(WorktreeSheet, {
      set: {
        imports: [FormsModule, MockTrackNativeModalDirective, MockPathAutocompleteInputComponent],
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
    worktreesServiceMock.getPoolByRepo.mockReturnValue(of([poolItem()]));
    const fixture = TestBed.createComponent(WorktreeSheet);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    const dialog = component.dialogRef as unknown as MockTrackNativeModalDirective;
    component.open(7, 'feature', '/tmp/repos/path-basename', 'repo-one');

    expect(component.createPath()).toBe('/tmp/repos/.worktrees/repo-one/feature');
    expect(component.pool()).toHaveLength(1);
    expect(worktreesServiceMock.getPoolByRepo).toHaveBeenCalledWith(7);
    expect(dialog.open).toHaveBeenCalledOnce();
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

  it('confirms takeover and dirty stashing before linking', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
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
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining('2 agents running will be stopped.'),
    );
  });
});
