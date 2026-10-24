import { TestBed } from '@angular/core/testing';
import { WorkbenchComponent } from './workbench.component';

describe('Workbench composition', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }));
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
  });

  it('exposes closed task intent and wires wider review back to the shell', async () => {
    const fixture = TestBed.createComponent(WorkbenchComponent);
    fixture.componentRef.setInput('tasks', [{ id: 'closed', title: 'Finished task', stage: 'closed', sessions: [] }]);
    fixture.componentRef.setInput('panelOpen', true);
    fixture.componentRef.setInput('wideReview', true);
    fixture.detectChanges();
    await fixture.whenStable();
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector('main')?.hasAttribute('inert')).toBe(true);
    root.querySelector('ex-app-shell')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.wideReview()).toBe(false);
    expect(root.querySelector('main')?.hasAttribute('inert')).toBe(false);
    const closed = vi.fn();
    fixture.componentInstance.closedTasksRequested.subscribe(closed);
    Array.from(root.querySelectorAll<HTMLButtonElement>('ex-task-list button')).find(button => button.textContent?.includes('Closed'))!.click();
    expect(closed).toHaveBeenCalledOnce();
  });

  it('counts live sub-task sessions and forwards their new-session intent', async () => {
    const fixture = TestBed.createComponent(WorkbenchComponent);
    fixture.componentRef.setInput('tasks', [{
      id: 'task', title: 'Checkout',
      sessions: [{ id: 'root', title: 'Root failure', status: 'failed' }],
      subtasks: [
        { id: 'work', title: 'Live branch', sessions: [
          { id: 'question', title: 'Needs an answer', status: 'attention' },
          { id: 'running', title: 'Working', status: 'running' },
          { id: 'review', title: 'Review changes', status: 'review' },
          { id: 'done', title: 'Finished', status: 'done' },
        ] },
        { id: 'merged', title: 'Merged branch', merged: true, sessions: [
          { id: 'old-question', title: 'Old question', status: 'attention' },
          { id: 'old-run', title: 'Old working', status: 'running' },
        ] },
      ],
    }]);
    const requested = vi.fn();
    fixture.componentInstance.subtaskSessionRequested.subscribe(requested);
    fixture.detectChanges();
    await fixture.whenStable();
    const root: HTMLElement = fixture.nativeElement;
    const summary = Array.from(root.querySelectorAll('ex-status-summary button')).map(button => button.textContent?.replace(/\s/g, ''));
    expect(summary).toEqual(['2Needsyou', '1Running', '1Review', '1Done']);
    root.querySelector<HTMLButtonElement>('[data-subtask-id="work"] button[aria-label="New session in this sub-task"]')?.click();
    expect(requested).toHaveBeenCalledWith({ taskId: 'task', subtaskId: 'work' });
    fixture.destroy();
  });
});
