import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
  it.each([false, true])('keeps collapsed tasks closed throughout stage moves (reduced motion: %s)', (reduced) => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: reduced, addEventListener: () => undefined, removeEventListener: () => undefined }));
    const fixture = TestBed.createComponent(TaskListComponent);
    fixture.nativeElement.style.setProperty('--dur-glide', '340ms');
    fixture.componentRef.setInput('tasks', tasks);
    fixture.detectChanges();
    const first = fixture.nativeElement.querySelector('[data-task-id="first"]') as HTMLElement;
    const second = fixture.nativeElement.querySelector('[data-task-id="second"]') as HTMLElement;
    const toggle = first.querySelector('header button') as HTMLButtonElement;
    toggle.click();
    fixture.detectChanges();
    const assertClosed = () => {
      for (const article of [first, second]) {
        expect(article.querySelector('header button')?.getAttribute('aria-expanded')).toBe('false');
        expect(article.querySelector(':scope > ex-fold')?.hasAttribute('inert')).toBe(true);
      }
    };
    assertClosed();
    for (const stages of [['waiting', 'active'], ['active', 'waiting']] as const) {
      fixture.componentRef.setInput('tasks', tasks.map((task, index) => ({ ...task, stage: stages[index]! })));
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-task-id="first"]')).toBe(first);
      expect(fixture.nativeElement.querySelector('[data-task-id="second"]')).toBe(second);
      assertClosed();
      vi.advanceTimersByTime(170);
      fixture.detectChanges();
      assertClosed();
      vi.advanceTimersByTime(500);
      fixture.detectChanges();
      assertClosed();
    }
    fixture.destroy();
  });

  it('still lets an expanded task glide before collapsing in Waiting', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
    const fixture = TestBed.createComponent(TaskListComponent);
    fixture.nativeElement.style.setProperty('--dur-glide', '340ms');
    fixture.componentRef.setInput('tasks', tasks);
    fixture.detectChanges();
    const toggle = fixture.nativeElement.querySelector('[data-task-id="first"] header button') as HTMLButtonElement;
    fixture.componentRef.setInput('tasks', [{ ...tasks[0]!, stage: 'waiting' }, tasks[1]!]);
    fixture.detectChanges();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    vi.advanceTimersByTime(170);
    fixture.detectChanges();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    vi.advanceTimersByTime(170);
    fixture.detectChanges();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
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

  it('makes an exiting task inert and revives its component and local fold state when it returns', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
    const fixture = TestBed.createComponent(TaskListComponent);
    fixture.componentRef.setInput('tasks', tasks);
    fixture.detectChanges();
    const first = fixture.nativeElement.querySelector('[data-task-id="first"]') as HTMLElement;
    const toggle = first.querySelector('header button') as HTMLButtonElement;
    toggle.click();
    fixture.detectChanges();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fixture.componentRef.setInput('tasks', [tasks[1]!]);
    fixture.detectChanges();
    expect(first.isConnected).toBe(true);
    expect(first.closest('ex-fold')?.hasAttribute('inert')).toBe(true);
    expect(first.closest('ex-fold')?.getAttribute('aria-hidden')).toBe('true');

    fixture.componentRef.setInput('tasks', [{ ...tasks[0]!, title: 'Returned task' }, tasks[1]!]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-task-id="first"]')).toBe(first);
    expect(first.textContent).toContain('Returned task');
    expect(first.closest('ex-fold')?.hasAttribute('inert')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fixture.destroy();
  });

  it('reveals the empty state and retires Closed without exposing its hidden control after removing all tasks', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
    const fixture = TestBed.createComponent(TaskListComponent);
    fixture.componentRef.setInput('tasks', [tasks[0]!, { ...tasks[1]!, stage: 'closed' }]);
    fixture.detectChanges();
    const closed = fixture.nativeElement.querySelector('button.closed') as HTMLButtonElement;
    const empty = fixture.nativeElement.querySelector('p.empty') as HTMLElement;
    const requested = vi.fn();
    fixture.componentInstance.closedRequested.subscribe(requested);
    closed.click();
    expect(requested).toHaveBeenCalledOnce();
    expect(closed.closest('[inert]')).toBeNull();
    expect(empty.closest('[inert]')).not.toBeNull();

    fixture.componentRef.setInput('tasks', []);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('p.empty')).toBe(empty);
    expect(empty.textContent).toContain('Your tasks will appear here.');
    expect(empty.closest('[inert]')).toBeNull();
    expect(closed.closest('[inert]')).not.toBeNull();
    const exiting = fixture.nativeElement.querySelector('[data-task-id="first"]') as HTMLElement;
    expect(exiting.closest('[inert]')).not.toBeNull();
    fixture.destroy();
  });

  it('preserves a selected session when it finishes, including IDs that resemble summary rows', () => {
    const fixture = TestBed.createComponent(TaskListComponent);
    const task: TaskOutline = {
      id: 'task', title: 'Session identity', stage: 'active',
      sessions: [{ id: 'finished-count', title: 'Selected work', status: 'running' }, { id: 'already-done', title: 'Earlier work', status: 'done' }],
    };
    fixture.componentRef.setInput('tasks', [task]);
    fixture.componentRef.setInput('selected', 'finished-count');
    fixture.detectChanges();
    const selected = fixture.nativeElement.querySelector('[aria-current="true"]') as HTMLButtonElement;
    const row = selected.closest('ex-session-row');
    expect(fixture.nativeElement.querySelectorAll('ex-session-row')).toHaveLength(2);

    fixture.componentRef.setInput('tasks', [{ ...task, sessions: task.sessions.map(session => ({ ...session, status: 'done' })) }]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[aria-current="true"]')).toBe(selected);
    expect(selected.closest('ex-session-row')).toBe(row);
    expect(selected.closest('[inert]')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('ex-session-row')).toHaveLength(2);
    expect(fixture.nativeElement.textContent).toContain('2 finished');
    const activated = vi.fn();
    fixture.componentInstance.selectSession.subscribe(activated);
    selected.click();
    expect(activated).toHaveBeenCalledWith({ taskId: 'task', sessionId: 'finished-count' });
  });
});
