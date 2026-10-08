import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { BranchesService } from '@/shared/services/branches.service';
import { TaskBranchPickerComponent } from './branch-picker.component';
import { BranchInfo } from '@/shared/models/branch.model';

describe('Task branch picker', () => {
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
});
