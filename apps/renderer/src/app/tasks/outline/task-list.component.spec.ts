import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskOutline } from '../task.models';
import { TaskListComponent } from './task-list.component';

const tasks: readonly TaskOutline[] = [
  {
    id: 'first',
    title: 'First task',
    stage: 'active',
    sessions: [
      { id: 'one', title: 'Earlier running', status: 'running' },
      { id: 'two', title: 'Later question', status: 'attention' },
      { id: 'three', title: 'Finished work', status: 'done' },
    ],
  },
  {
    id: 'second',
    title: 'Second task',
    stage: 'waiting',
    sessions: [{ id: 'four', title: 'Failure', status: 'failed' }],
  },
];
describe('task outline ownership', () => {
  beforeEach(async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    await TestBed.configureTestingModule({
      imports: [TaskListComponent],
    }).compileComponents();
  });
  it('keeps order, folds finished sessions and exposes selection intents', () => {
    const fixture = TestBed.createComponent(TaskListComponent);
    fixture.componentRef.setInput('tasks', tasks);
    const selected = vi.fn();
    fixture.componentInstance.selectSession.subscribe(selected);
    fixture.detectChanges();
    const first = fixture.nativeElement.querySelector('[data-task-id="first"]');
    expect(first.textContent).toContain('1 finished');
    const rows = first.querySelectorAll('ex-session-row');
    expect(rows[0]?.textContent).toContain('Earlier running');
    expect(rows[1]?.textContent).toContain('Later question');
    expect(rows[2]?.closest('ex-fold')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    rows[1]?.querySelector('button')?.click();
    expect(selected).toHaveBeenCalledWith({
      taskId: 'first',
      sessionId: 'two',
    });
  });
  it('keeps task DOM identity through stage moves and filtering', () => {
    const fixture = TestBed.createComponent(TaskListComponent);
    fixture.componentRef.setInput('tasks', tasks);
    fixture.detectChanges();
    const first = fixture.nativeElement.querySelector('[data-task-id="first"]');
    fixture.componentRef.setInput('tasks', [
      { ...tasks[0]!, stage: 'waiting' },
      tasks[1]!,
    ]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-task-id="first"]')).toBe(
      first,
    );
    fixture.componentRef.setInput('filter', 'done');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-task-id="first"]')).toBe(
      first,
    );
    expect(first.querySelector('ex-session-row').textContent).toContain(
      'Finished work',
    );
    fixture.componentRef.setInput('filter', null);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-task-id="first"]')).toBe(
      first,
    );
    fixture.destroy();
  });
  it('includes failed sessions under Needs you and reveals the selected finished session', () => {
    const fixture = TestBed.createComponent(TaskListComponent);
    fixture.componentRef.setInput('tasks', tasks);
    fixture.componentRef.setInput('filter', 'attention');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Failure');
    fixture.componentRef.setInput('filter', null);
    fixture.componentRef.setInput('selected', 'three');
    fixture.detectChanges();
    const row = fixture.nativeElement.querySelector('[aria-current="true"]');
    expect(row?.textContent).toContain('Finished work');
    expect(row?.closest('ex-fold')?.getAttribute('aria-hidden')).toBe('false');
  });
});
