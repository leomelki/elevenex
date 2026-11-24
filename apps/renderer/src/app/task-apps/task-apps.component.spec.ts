import { TestBed } from '@angular/core/testing';
import type { BackendResult, TaskAppRun } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { TaskAppsComponent } from './task-apps.component';

const run = (taskId: number, runId: string): TaskAppRun => ({
  taskId, runId, name: 'Preview ' + runId, mode: 'native', status: 'running', startedAt: 1,
});

describe('Task apps panel ownership', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('discards late metadata from the previous task and never substitutes an unrelated run for a chat link', async () => {
    let finish!: (r: BackendResult<readonly TaskAppRun[]>) => void;
    const taskAppsRead = vi.fn(async (_scope: string, taskId: number): Promise<BackendResult<readonly TaskAppRun[]>> => {
      if (taskId === 1) return new Promise(r => { finish = r; });
      return { ok: true, value: [run(taskId, 'fresh')] };
    });
    TestBed.configureTestingModule({ providers: [{ provide: ELEVENEX_BRIDGE, useValue: { taskAppsRead } }] });
    const view = TestBed.createComponent(TaskAppsComponent);
    view.componentRef.setInput('scopeId', 'machine');
    view.componentRef.setInput('taskId', 1);
    view.detectChanges();
    view.componentRef.setInput('taskId', 2);
    view.detectChanges();
    await view.whenStable();
    finish({ ok: true, value: [run(1, 'wrong')] });
    await view.whenStable();
    expect(view.componentInstance.run()?.runId).toBe('fresh');
    view.componentRef.setInput('link', { scopeId: 'machine', taskId: 2, runId: 'missing' });
    view.detectChanges();
    await view.whenStable();
    expect(view.nativeElement.textContent).toContain('This run is unavailable');
    expect(view.nativeElement.textContent).not.toContain('Stop app');
  });
  it('shows the exact pending executable and argument boundaries and launches only after an explicit click', async () => {
    const proposal: TaskAppRun = { ...run(2, 'request'), status: 'requested', pendingLaunch: { executable: 'pnpm', args: ['run', 'dev app', 'x\u202ey'] } };
    const taskAppApprove = vi.fn(async () => ({ ok: true, value: undefined }));
    const taskAppsRead = vi.fn(async () => ({ ok: true, value: [proposal] }));
    TestBed.configureTestingModule({ providers: [{ provide: ELEVENEX_BRIDGE, useValue: { taskAppsRead, taskAppApprove } }] });
    const fixture = TestBed.createComponent(TaskAppsComponent);
    fixture.componentRef.setInput('scopeId', 'machine');
    fixture.componentRef.setInput('taskId', 2);
    fixture.detectChanges(); await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    await vi.waitFor(() => { fixture.detectChanges(); expect(element.querySelector('.approval pre')).not.toBeNull(); });
    const text = element.querySelector('.approval pre')!.textContent;
    expect(text).toContain('"dev app"');
    expect(text).toContain('x\\u202ey');
    expect(taskAppApprove).not.toHaveBeenCalled();
    element.querySelector<HTMLButtonElement>('button[data-variant=primary]')!.click();
    await fixture.whenStable();
    expect(taskAppApprove).toHaveBeenCalledExactlyOnceWith('machine', 2, 'request');
  });
});
