import { TestBed } from '@angular/core/testing';
import { WorkbenchComponent } from './workbench.component';

describe('Workbench composition', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
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
});
