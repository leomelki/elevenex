import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Z_MODAL_DATA } from '@/shared/components/dialog/dialog.service';
import { ZardDialogRef } from '@/shared/components/dialog/dialog-ref';
import { WorktreesService } from '@/shared/services/worktrees.service';
import { TaskCreateComponent } from './task-create.component';
import { TasksApiService } from './tasks-api.service';
import { TaskOperationsService } from './task-operations.service';
import { taskSlug } from './task.model';

describe('Task creation', () => {
  const api = { defaults: vi.fn(), create: vi.fn() };
  const close = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    api.defaults.mockReturnValue(of({ baseRef: 'origin/main', branchName: 'task' }));
    TestBed.configureTestingModule({
      imports: [TaskCreateComponent],
      providers: [
        { provide: Z_MODAL_DATA, useValue: { repoId: 1, repoName: 'Example' } },
        { provide: ZardDialogRef, useValue: { close } },
        { provide: TasksApiService, useValue: api },
        { provide: TaskOperationsService, useValue: { track: vi.fn() } },
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: WorktreesService, useValue: { getPoolByRepoStream: () => of([]) } },
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
    expect(component.canCreate()).toBe(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-create-task-submit]').disabled).toBe(true);
  });
  it('trims branch suggestions at a valid separator', () => {
    expect(taskSlug('a'.repeat(99) + ' / more')).toBe('a'.repeat(99));
  });
});
