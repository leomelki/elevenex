import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BranchesService } from '@/shared/services/branches.service';
import { TaskBranchPickerComponent } from './branch-picker.component';
import { BranchInfo } from '@/shared/models/branch.model';

describe('Task branch picker', () => {
  afterEach(() => vi.useRealTimers());
  const branch = (isRemote: boolean): BranchInfo => ({
    name: 'origin/review',
    isRemote,
    commit: 'abc',
    current: false,
    hasWorktree: false,
    worktreePath: null,
    label: '',
  });
  it('distinguishes an identically named local and remote branch', () => {
    TestBed.configureTestingModule({
      imports: [TaskBranchPickerComponent],
      providers: [
        {
          provide: BranchesService,
          useValue: { searchBranches: () => of([]), searchRemoteBranches: () => of([]) },
        },
      ],
    });
    const fixture = TestBed.createComponent(TaskBranchPickerComponent);
    fixture.componentRef.setInput('repoId', 1);
    fixture.componentRef.setInput('selected', 'refs/heads/origin/review');
    expect(fixture.componentInstance.isSelected(branch(false))).toBe(true);
    expect(fixture.componentInstance.isSelected(branch(true))).toBe(false);
  });
  it('uses arrows and Enter to select a branch without submitting the parent form', () => {
    TestBed.configureTestingModule({
      imports: [TaskBranchPickerComponent],
      providers: [
        {
          provide: BranchesService,
          useValue: { searchBranches: () => of([]), searchRemoteBranches: () => of([]) },
        },
      ],
    });
    const fixture = TestBed.createComponent(TaskBranchPickerComponent);
    fixture.componentRef.setInput('repoId', 1);
    const component = fixture.componentInstance;
    component.loading.set(false);
    component.branches.set([branch(false), branch(true)]);
    const picked = vi.fn();
    const confirmed = vi.fn();
    component.picked.subscribe(picked);
    component.confirmed.subscribe(confirmed);
    component.key(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    component.key(enter);
    expect(picked).toHaveBeenCalledWith(branch(true));
    expect(enter.defaultPrevented).toBe(true);
    expect(confirmed).not.toHaveBeenCalled();
    fixture.componentRef.setInput('selected', 'refs/remotes/origin/review');
    component.key(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    expect(confirmed).toHaveBeenCalledOnce();
    expect(picked).toHaveBeenCalledTimes(1);
  });
  function picker(local: unknown = of([]), remote: unknown = of([])) {
    const api = {
      searchBranches: vi.fn().mockReturnValue(local),
      searchRemoteBranches: vi.fn().mockReturnValue(remote),
    };
    TestBed.configureTestingModule({
      imports: [TaskBranchPickerComponent],
      providers: [{ provide: BranchesService, useValue: api }],
    });
    const fixture = TestBed.createComponent(TaskBranchPickerComponent);
    fixture.componentRef.setInput('repoId', 1);
    return { fixture, api, component: fixture.componentInstance };
  }
  it('prefills the generated name and selects Create above fuzzy matches', async () => {
    vi.useFakeTimers();
    const { fixture, component } = picker(of([{ ...branch(false), name: 'fix-search-previous' }]));
    fixture.componentRef.setInput('initialQuery', 'fix-search');
    fixture.componentRef.setInput('allowCreate', true);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(150);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('input').value).toBe('fix-search');
    expect(component.options()[0]).toEqual({ kind: 'create', name: 'fix-search' });
    const create = vi.fn();
    component.createRequested.subscribe(create);
    component.key(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    expect(create).toHaveBeenCalledWith('fix-search');
  });
  it('uses an exact existing branch instead of offering to create it', async () => {
    vi.useFakeTimers();
    const { fixture, component } = picker(
      of([]),
      of([{ ...branch(true), name: 'upstream/review' }]),
    );
    fixture.componentRef.setInput('initialQuery', 'review');
    fixture.componentRef.setInput('allowCreate', true);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(150);
    expect(component.canCreate()).toBe(false);
    const picked = vi.fn();
    component.picked.subscribe(picked);
    component.activate();
    expect(picked).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'upstream/review', isRemote: true }),
    );
  });
  it('pins and accepts the preselected default even outside the search result limit', async () => {
    vi.useFakeTimers();
    const locals = Array.from({ length: 120 }, (_, i) => ({
      ...branch(false),
      name: `feature-${i}`,
    }));
    const { fixture, component } = picker(of(locals));
    fixture.componentRef.setInput('recommendedRef', 'refs/remotes/origin/master');
    fixture.componentRef.setInput('selected', 'refs/remotes/origin/master');
    fixture.detectChanges();
    const accept = vi.fn();
    component.referencePicked.subscribe(accept);
    component.key(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    expect(accept).toHaveBeenCalledWith('refs/remotes/origin/master');
    await vi.advanceTimersByTimeAsync(150);
    fixture.detectChanges();
    expect(component.options().length).toBe(101);
    expect(component.index()).toBe(0);
    expect(fixture.nativeElement.querySelector('[role="option"]').textContent).toContain(
      'origin/master',
    );
    expect(
      fixture.nativeElement.querySelector('[role="option"]').getAttribute('aria-selected'),
    ).toBe('true');
    component.search('feature-12');
    expect(component.options().some((item) => item.kind === 'default')).toBe(false);
  });
  it('cancels old searches immediately, including during the next search debounce', async () => {
    vi.useFakeTimers();
    const oldLocal = new Subject<BranchInfo[]>();
    const oldRemote = new Subject<BranchInfo[]>();
    const { fixture, api, component } = picker(oldLocal, oldRemote);
    fixture.componentRef.setInput('initialQuery', 'older');
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(150);
    api.searchBranches.mockReturnValue(of([{ ...branch(false), name: 'newer' }]));
    api.searchRemoteBranches.mockReturnValue(of([]));
    component.search('newer');
    fixture.detectChanges();
    oldLocal.next([{ ...branch(false), name: 'older' }]);
    oldRemote.next([]);
    oldLocal.complete();
    oldRemote.complete();
    expect(component.loading()).toBe(true);
    expect(component.branches()).toEqual([]);
    await vi.advanceTimersByTimeAsync(150);
    expect(component.branches().map((item) => item.name)).toEqual(['newer']);
  });
  it('loads the first results without waiting for the typing debounce', async () => {
    vi.useFakeTimers();
    const { fixture, api, component } = picker(of([{ ...branch(false), name: 'review' }]));
    fixture.componentRef.setInput('initialQuery', ' review ');
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.searchBranches).toHaveBeenCalledWith(1, 'review', true);
    expect(component.loading()).toBe(false);
    component.search('reviews');
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(100);
    expect(api.searchBranches).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(api.searchBranches).toHaveBeenLastCalledWith(1, 'reviews', true);
  });
  it('narrows the previous results and keeps Create visible while a search runs', async () => {
    vi.useFakeTimers();
    const { fixture, api, component } = picker(
      of([
        { ...branch(false), name: 'review-api' },
        { ...branch(false), name: 'release' },
      ]),
    );
    fixture.componentRef.setInput('initialQuery', 're');
    fixture.componentRef.setInput('allowCreate', true);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    api.searchBranches.mockReturnValue(new Subject());
    component.search('review');
    fixture.detectChanges();
    expect(component.loading()).toBe(true);
    expect(component.options().map((option) => component.optionKey(option))).toEqual([
      'create',
      'refs/heads/review-api',
    ]);
    const buttons = fixture.nativeElement.querySelectorAll('[role="option"]');
    expect([...buttons].every((button: HTMLButtonElement) => !button.disabled)).toBe(true);
    const picked = vi.fn();
    component.picked.subscribe(picked);
    component.choose(component.options()[1]);
    expect(picked).toHaveBeenCalledWith(expect.objectContaining({ name: 'review-api' }));
  });
  it('creates once the pending lookup confirms the name is new', async () => {
    vi.useFakeTimers();
    const { fixture, api, component } = picker();
    fixture.componentRef.setInput('allowCreate', true);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    const local = new Subject<BranchInfo[]>();
    api.searchBranches.mockReturnValue(local);
    component.search('review-api');
    const create = vi.fn();
    component.createRequested.subscribe(create);
    component.key(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    expect(create).not.toHaveBeenCalled();
    expect(component.createPending()).toBe(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Checking name…');
    await vi.advanceTimersByTimeAsync(150);
    local.next([{ ...branch(false), name: 'review-api-old' }]);
    local.complete();
    expect(create).toHaveBeenCalledExactlyOnceWith('review-api');
    expect(component.createPending()).toBe(false);
  });
  it('highlights an existing branch instead of creating a duplicate after a pending lookup', async () => {
    vi.useFakeTimers();
    const { fixture, api, component } = picker();
    fixture.componentRef.setInput('allowCreate', true);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    api.searchRemoteBranches.mockReturnValue(of([{ ...branch(true), name: 'origin/review' }]));
    component.search('review');
    const create = vi.fn();
    const picked = vi.fn();
    component.createRequested.subscribe(create);
    component.picked.subscribe(picked);
    component.activate();
    await vi.advanceTimersByTimeAsync(150);
    expect(create).not.toHaveBeenCalled();
    expect(picked).not.toHaveBeenCalled();
    expect(component.options()[component.index()]).toEqual(
      expect.objectContaining({
        kind: 'branch',
        branch: expect.objectContaining({ name: 'origin/review' }),
      }),
    );
  });
  it('keeps an arrow-key highlight when results refresh', async () => {
    vi.useFakeTimers();
    const results = ['review-a', 'review-b', 'review-c'].map((name) => ({
      ...branch(false),
      name,
    }));
    const { fixture, api, component } = picker(of(results));
    fixture.componentRef.setInput('initialQuery', 'review');
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    const local = new Subject<BranchInfo[]>();
    api.searchBranches.mockReturnValue(local);
    component.search('review-');
    fixture.detectChanges();
    // jsdom does not implement scrolling.
    fixture.nativeElement.querySelectorAll('[role="option"]').forEach((option: HTMLElement) => {
      option.scrollIntoView = vi.fn();
    });
    component.key(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
    expect(component.index()).toBe(1);
    await vi.advanceTimersByTimeAsync(150);
    local.next([results[0], results[2], results[1]]);
    local.complete();
    expect(component.index()).toBe(2);
    expect(component.options()[2]).toEqual({ kind: 'branch', branch: results[1] });
  });
  it('does not offer creation when branch lookup fails or allow duplicate activation while busy', async () => {
    vi.useFakeTimers();
    const { fixture, component } = picker(throwError(() => new Error('offline')));
    fixture.componentRef.setInput('initialQuery', 'review');
    fixture.componentRef.setInput('allowCreate', true);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(150);
    expect(component.error()).toContain('Could not load');
    expect(component.canCreate()).toBe(false);
    component.branches.set([branch(false)]);
    fixture.componentRef.setInput('disabled', true);
    const picked = vi.fn();
    component.picked.subscribe(picked);
    component.activate();
    expect(picked).not.toHaveBeenCalled();
  });
});
