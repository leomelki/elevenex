import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Z_MODAL_DATA } from '@/shared/components/dialog/dialog.service';
import { ZardDialogRef } from '@/shared/components/dialog/dialog-ref';
import { WorktreesService } from '@/shared/services/worktrees.service';
import { BranchesService } from '@/shared/services/branches.service';
import { WorktreePoolItem } from '@/shared/models/worktree.model';
import { BranchInfo } from '@/shared/models/branch.model';
import { TaskCreateComponent } from './task-create.component';
import { TasksApiService } from './tasks-api.service';
import { TaskOperationsService } from './task-operations.service';
import { taskSlug } from './task.model';

describe('Task creation', () => {
  const api = { defaults: vi.fn(), create: vi.fn() };
  const close = vi.fn();
  const worktrees = { getPoolByRepoStream: vi.fn() };
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.clearAllMocks();
    api.defaults.mockReturnValue(of({ baseRef: 'origin/main', branchName: 'task' }));
    worktrees.getPoolByRepoStream.mockReturnValue(of([]));
    TestBed.configureTestingModule({
      imports: [TaskCreateComponent],
      providers: [
        { provide: Z_MODAL_DATA, useValue: { repoId: 1, repoName: 'Example' } },
        { provide: ZardDialogRef, useValue: { close } },
        { provide: TasksApiService, useValue: api },
        { provide: TaskOperationsService, useValue: { track: vi.fn() } },
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: WorktreesService, useValue: worktrees },
        {
          provide: BranchesService,
          useValue: { searchBranches: () => of([]), searchRemoteBranches: () => of([]) },
        },
      ],
    });
  });
  it('generates a readable branch, while a manual branch survives later name edits', () => {
    const component = TestBed.createComponent(TaskCreateComponent).componentInstance;
    component.setName('Investigate café latency');
    expect(component.branch()).toBe('investigate-cafe-latency');
    component.setBranch('reviews/42');
    component.setName('Review authentication');
    expect(component.branch()).toBe('reviews/42');
    expect(component.canCreate()).toBe(true);
  });
  it('allows an existing branch without requiring a task name or generating a new branch', () => {
    const component = TestBed.createComponent(TaskCreateComponent).componentInstance;
    component.setMode('existing');
    component.setBranch('refs/remotes/upstream/review');
    component.setName('');
    expect(component.canCreate()).toBe(true);
    expect(component.branch()).toBe('refs/remotes/upstream/review');
  });
  it('keeps the same request identity after a failed response', () => {
    const component = TestBed.createComponent(TaskCreateComponent).componentInstance;
    component.setName('Review search');
    api.create.mockReturnValue(throwError(() => ({ error: { message: 'Connection lost' } })));
    component.create();
    component.create();
    expect(api.create).toHaveBeenCalledTimes(2);
    expect(api.create.mock.calls[0][1].requestId).toBe(api.create.mock.calls[1][1].requestId);
    expect(close).not.toHaveBeenCalled();
    expect(component.error()).toBe('Connection lost');
  });
  it('accepts a task once even when Create is pressed twice', () => {
    const component = TestBed.createComponent(TaskCreateComponent).componentInstance;
    component.setName('Investigate');
    api.create.mockReturnValue(new Subject());
    component.create();
    component.create();
    expect(api.create).toHaveBeenCalledTimes(1);
  });
  it('does not silently select a base when the repository has no default', () => {
    api.defaults.mockReturnValue(of({ baseRef: null, branchName: 'task' }));
    const fixture = TestBed.createComponent(TaskCreateComponent);
    const component = fixture.componentInstance;
    component.setName('Investigate');
    component.chooseNewBranch('investigate');
    expect(component.canCreate()).toBe(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-create-task-submit]').disabled).toBe(true);
  });
  it('separates setup, branch, and base and preserves edits when going back', () => {
    const fixture = TestBed.createComponent(TaskCreateComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#task-name')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('app-task-branch-picker')).toBeNull();
    component.setName('Review search');
    component.selectEnvironment('new');
    component.submit();
    fixture.detectChanges();
    expect(component.step()).toBe('branch');
    expect(component.branchQuery()).toBe('review-search');
    expect(fixture.nativeElement.querySelector('#task-name')).toBeNull();
    expect(fixture.nativeElement.querySelector('#task-branch-search').value).toBe('review-search');
    component.chooseNewBranch('reviews/search');
    fixture.detectChanges();
    expect(component.step()).toBe('base');
    expect(component.base()).toBe('origin/main');
    const recommended = fixture.nativeElement.querySelector('[data-branch-kind="default"]');
    expect(recommended.textContent).toContain('Default');
    expect(recommended.getAttribute('aria-selected')).toBe('true');
    component.back();
    fixture.detectChanges();
    expect(component.branchQuery()).toBe('reviews/search');
    component.back();
    fixture.detectChanges();
    component.setName('A different title');
    component.continue();
    expect(component.branchQuery()).toBe('reviews/search');
    expect(component.environment()).toBe('new');
    expect(api.create).not.toHaveBeenCalled();
    component.editBranchQuery('still-typing');
    component.back();
    component.continue();
    expect(component.branchQuery()).toBe('still-typing');
  });
  it('creates an existing remote branch task directly without visiting the base step', () => {
    const component = TestBed.createComponent(TaskCreateComponent).componentInstance;
    api.create.mockReturnValue(new Subject());
    component.setName('Review');
    component.continue();
    component.chooseExistingBranch({ name: 'upstream/review', isRemote: true } as BranchInfo);
    expect(component.step()).toBe('branch');
    expect(api.create).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        mode: 'existing',
        branchName: 'refs/remotes/upstream/review',
        baseRef: undefined,
      }),
    );
  });
  it('waits for a unique generated name instead of accidentally selecting an existing branch', async () => {
    vi.useFakeTimers();
    const suggestion = new Subject<{ baseRef: string; branchName: string }>();
    api.defaults.mockImplementation((_repoId, name) =>
      name ? suggestion : of({ baseRef: 'origin/main', branchName: 'task' }),
    );
    TestBed.overrideProvider(BranchesService, {
      useValue: {
        searchBranches: () => of([{ name: 'review', isRemote: false } as BranchInfo]),
        searchRemoteBranches: () => of([]),
      },
    });
    const fixture = TestBed.createComponent(TaskCreateComponent);
    const component = fixture.componentInstance;
    component.setName('Review');
    component.continue();
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(210);
    fixture.detectChanges();
    expect(component.canSubmit()).toBe(false);
    fixture.nativeElement
      .querySelector('#task-branch-search')
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    expect(api.create).not.toHaveBeenCalled();
    expect(component.step()).toBe('branch');
    suggestion.next({ baseRef: 'origin/main', branchName: 'review-2' });
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(150);
    fixture.detectChanges();
    expect(component.branchQuery()).toBe('review-2');
    expect(component.canSubmit()).toBe(true);
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('#task-branch-search'));
    // jsdom does not implement scrolling; keep the keyboard selection behavior real.
    fixture.nativeElement.querySelectorAll('[role="option"]').forEach((option: HTMLElement) => {
      option.scrollIntoView = vi.fn();
    });
    expect(component.submitLabel()).toBe('Continue');
    fixture.nativeElement
      .querySelector('#task-branch-search')
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
    expect(component.submitLabel()).toBe('Create task');
    fixture.nativeElement
      .querySelector('#task-branch-search')
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
      );
    fixture.nativeElement
      .querySelector('#task-branch-search')
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    expect(component.step()).toBe('base');
    expect(component.branch()).toBe('review-2');
    expect(api.create).not.toHaveBeenCalled();
  });
  it('creates only after accepting the base, preserving the custom branch name and worktree', () => {
    const fixture = TestBed.createComponent(TaskCreateComponent);
    const component = fixture.componentInstance;
    api.create.mockReturnValue(new Subject());
    component.setName('Review');
    component.selectEnvironment('new');
    component.continue();
    component.chooseNewBranch('reviews/api');
    expect(api.create).not.toHaveBeenCalled();
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('#task-branch-search');
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(api.create).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        name: 'Review',
        mode: 'new',
        branchName: 'reviews/api',
        baseRef: 'origin/main',
        environment: 'new',
      }),
    );
    component.back();
    expect(component.step()).toBe('base');
    component.create();
    expect(api.create).toHaveBeenCalledOnce();
  });
  it('shows unavailable worktrees and prevents continuing with a stale worktree selection', () => {
    const stream = new Subject<WorktreePoolItem[]>();
    worktrees.getPoolByRepoStream.mockReturnValue(stream);
    const component = TestBed.createComponent(TaskCreateComponent).componentInstance;
    const clean = { id: 2, name: 'Spare', path: '/spare' } as WorktreePoolItem;
    component.selectEnvironment('existing');
    component.selectEnvironment('automatic');
    component.selectEnvironment('existing');
    expect(worktrees.getPoolByRepoStream).toHaveBeenCalledOnce();
    stream.next([
      clean,
      { ...clean, id: 3, owner: {} } as WorktreePoolItem,
      { ...clean, id: 4, isDirty: true },
    ]);
    component.worktreeId.set(2);
    expect(component.canContinue()).toBe(true);
    expect(component.availableEnvironments().map((item) => item.badge)).toEqual([
      undefined,
      'In use',
      'Local edits',
    ]);
    stream.next([{ ...clean, isDirty: true }]);
    expect(component.canContinue()).toBe(false);
    component.continue();
    expect(component.step()).toBe('setup');
    stream.complete();
    expect(component.noAvailableWorktrees()).toBe(true);
    component.selectEnvironment('automatic');
    expect(component.canContinue()).toBe(true);
  });
  it('uses the highlighted base when Create task is clicked', async () => {
    vi.useFakeTimers();
    TestBed.overrideProvider(BranchesService, {
      useValue: {
        searchBranches: () => of([{ name: 'release', isRemote: false } as BranchInfo]),
        searchRemoteBranches: () => of([]),
      },
    });
    const fixture = TestBed.createComponent(TaskCreateComponent);
    const component = fixture.componentInstance;
    api.create.mockReturnValue(new Subject());
    component.chooseNewBranch('review-test');
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(150);
    fixture.detectChanges();
    fixture.nativeElement.querySelectorAll('[role="option"]').forEach((option: HTMLElement) => {
      option.scrollIntoView = vi.fn();
    });
    fixture.nativeElement
      .querySelector('#task-branch-search')
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-create-task-submit]').click();
    expect(api.create).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ baseRef: 'refs/heads/release' }),
    );
  });

  it('does not submit the previous base when a search has no matches', async () => {
    vi.useFakeTimers();
    const fixture = TestBed.createComponent(TaskCreateComponent);
    const component = fixture.componentInstance;
    api.create.mockReturnValue(new Subject());
    component.chooseNewBranch('review-test');
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('#task-branch-search');
    input.value = 'missing-branch';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(150);
    fixture.detectChanges();
    expect(component.canSubmit()).toBe(false);
    component.submit();
    expect(api.create).not.toHaveBeenCalled();
    component.toggleCustomReference();
    component.base.set('my-tag');
    component.submit();
    expect(api.create).toHaveBeenCalledWith(1, expect.objectContaining({ baseRef: 'my-tag' }));
  });

  it('trims branch suggestions at a valid separator', () => {
    expect(taskSlug('a'.repeat(99) + ' / more')).toBe('a'.repeat(99));
  });
});
