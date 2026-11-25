import { TestBed } from '@angular/core/testing';
import type { BackendResult, TaskAppRun } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { TaskAppsComponent } from './task-apps.component';

const run = (taskId: number, runId: string): TaskAppRun => ({
  taskId, runId, name: 'Preview ' + runId, mode: 'native', status: 'running', startedAt: 1,
});

describe('Task apps panel ownership', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('guides the remote viewer to host settings and launches only after a separate confirmation', async () => {
    let state: TaskAppRun = {
      ...run(2, 'request'), mode: 'stream', status: 'requested', setupIssue: 'macos-screen-recording',
      pendingLaunch: { executable: 'pnpm', args: ['desktop:dev'] },
    };
    const taskAppsRead = vi.fn(async () => ({ ok: true as const, value: [state] }));
    const taskAppOpenSetupSettings = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const writeClipboardText = vi.fn(async () => undefined);
    const taskAppApprove = vi.fn(async () => {
      state = { ...run(2, 'request'), status: 'starting' };
      return { ok: true as const, value: undefined };
    });
    TestBed.configureTestingModule({ providers: [{ provide: ELEVENEX_BRIDGE, useValue: {
      taskAppsRead, taskAppOpenSetupSettings, writeClipboardText, taskAppApprove,
    } }] });
    const fixture = TestBed.createComponent(TaskAppsComponent);
    fixture.componentRef.setInput('scopeId', 'machine');
    fixture.componentRef.setInput('taskId', 2);
    fixture.componentRef.setInput('machine', 'Studio Mac');
    fixture.componentRef.setInput('remote', true);
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const button = (name: string) => [...element.querySelectorAll('button')].find(b => b.textContent?.trim() === name);
    await vi.waitFor(() => { fixture.detectChanges(); expect(button('Open settings on host')).toBeDefined(); });
    expect(element.textContent).toContain('Screen & System Audio Recording');
    expect(fixture.componentInstance.hasActiveApp()).toBe(true);
    button('Open settings on host')!.click();
    await vi.waitFor(() => { fixture.detectChanges(); expect(element.textContent).toContain('Settings opened on the task machine.'); });
    expect(taskAppOpenSetupSettings).toHaveBeenCalledExactlyOnceWith('machine', 2, 'request');
    expect(taskAppApprove).not.toHaveBeenCalled();
    button('Copy instructions')!.click();
    expect(writeClipboardText).toHaveBeenCalledWith(expect.stringContaining('Studio Mac'));
    button('Check and launch')!.click();
    await vi.waitFor(() => { fixture.detectChanges(); expect(element.textContent).toContain('Starting…'); });
    expect(taskAppApprove).toHaveBeenCalledExactlyOnceWith('machine', 2, 'request');
  });
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
    await vi.waitFor(() => {
      view.detectChanges();
      expect(view.nativeElement.textContent).toContain('This run is unavailable');
    });
    expect(view.nativeElement.querySelector('button[aria-label="Stop app"]')).toBeNull();
  });
  it('keeps run actions in one toolbar and folds logs in under the app on request', async () => {
    const taskAppOutput = vi.fn(async () => ({ ok: true as const, value: 'ready on :5173' }));
    const taskAppsRead = vi.fn(async () => ({ ok: true as const, value: [run(3, 'native')] }));
    TestBed.configureTestingModule({ providers: [{ provide: ELEVENEX_BRIDGE, useValue: { taskAppsRead, taskAppOutput } }] });
    const fixture = TestBed.createComponent(TaskAppsComponent);
    fixture.componentRef.setInput('scopeId', 'machine');
    fixture.componentRef.setInput('taskId', 3);
    fixture.detectChanges(); await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    await vi.waitFor(() => { fixture.detectChanges(); expect(element.querySelector('[role=tab][aria-selected=true]')?.textContent?.trim()).toBe('Preview native'); });
    const logs = element.querySelector<HTMLButtonElement>('.tools button[aria-label=Logs]')!;
    expect(element.querySelector('.tools button[aria-label="Stop app"]')).not.toBeNull();
    expect(logs.getAttribute('aria-pressed')).toBe('false');
    logs.click();
    await vi.waitFor(() => { fixture.detectChanges(); expect(element.querySelector('.logs pre')?.textContent).toBe('ready on :5173'); });
    expect(logs.getAttribute('aria-pressed')).toBe('true');
    expect(taskAppOutput).toHaveBeenCalledWith('machine', 3, 'native');
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
  it('shows each run as a tab without create or close controls and switches runs by tab', async () => {
    const runs: readonly TaskAppRun[] = [run(4, 'web'), { ...run(4, 'api'), status: 'exited' }];
    const taskAppsRead = vi.fn(async () => ({ ok: true as const, value: runs }));
    TestBed.configureTestingModule({ providers: [{ provide: ELEVENEX_BRIDGE, useValue: { taskAppsRead } }] });
    const fixture = TestBed.createComponent(TaskAppsComponent);
    fixture.componentRef.setInput('scopeId', 'machine');
    fixture.componentRef.setInput('taskId', 4);
    fixture.detectChanges(); await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    const tabs = () => [...element.querySelectorAll<HTMLButtonElement>('[role=tab]')];
    await vi.waitFor(() => { fixture.detectChanges(); expect(tabs().map(tab => tab.textContent?.trim())).toEqual(['Preview web', 'Preview api']); });
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('true');
    expect(element.querySelector('ex-view-tabs .new, ex-view-tabs .close')).toBeNull();
    expect(element.querySelector('ex-view-tabs [aria-label=Running]')).not.toBeNull();
    tabs()[1]!.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.run()?.runId).toBe('api');
    expect(element.querySelector('.tools button[aria-label="Stop app"]')).toBeNull();
    expect(element.querySelector('.state h2')?.textContent).toBe('App exited');
  });
});
