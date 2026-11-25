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
    const helperPath = '/Users/test/.elevenex/runtime/backend/bin/task-app-macos';
    const taskAppRevealSetupHelper = vi.fn(async () => ({ ok: true as const, value: { path: helperPath, revealed: true } }));
    const taskAppApprove = vi.fn(async () => {
      state = { ...run(2, 'request'), status: 'starting' };
      return { ok: true as const, value: undefined };
    });
    TestBed.configureTestingModule({ providers: [{ provide: ELEVENEX_BRIDGE, useValue: {
      taskAppsRead, taskAppOpenSetupSettings, taskAppRevealSetupHelper, writeClipboardText, taskAppApprove,
    } }] });
    const fixture = TestBed.createComponent(TaskAppsComponent);
    fixture.componentRef.setInput('scopeId', 'machine');
    fixture.componentRef.setInput('taskId', 2);
    fixture.componentRef.setInput('machine', 'Studio Mac');
    fixture.componentRef.setInput('remote', true);
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const button = (name: string) => [...element.querySelectorAll('button')].find(b => b.textContent?.trim() === name);
    await vi.waitFor(() => { fixture.detectChanges(); expect(button('Open setup on host')).toBeDefined(); });
    expect(element.textContent).toContain('Screen & System Audio Recording');
    expect(fixture.componentInstance.hasActiveApp()).toBe(true);
    button('Open setup on host')!.click();
    await vi.waitFor(() => { fixture.detectChanges(); expect(element.textContent).toContain('Elevenex Agent was asked to open on Studio Mac. Look at that screen to continue.');
    expect(element.textContent).toContain('Someone there needs to complete them'); });
    expect(taskAppOpenSetupSettings).toHaveBeenCalledExactlyOnceWith('machine', 2, 'request');
    expect(taskAppApprove).not.toHaveBeenCalled();
    button('Show agent in Finder on host')!.click();
    await vi.waitFor(() => { fixture.detectChanges(); expect(button('Copy app path')).toBeDefined(); });
    expect(taskAppRevealSetupHelper).toHaveBeenCalledExactlyOnceWith('machine', 2, 'request');
    button('Copy app path')!.click();
    expect(writeClipboardText).toHaveBeenCalledWith(helperPath);
    button('Copy instructions')!.click();
    expect(writeClipboardText).toHaveBeenCalledWith(expect.stringContaining('Studio Mac'));
    button('Check and launch')!.click();
    await vi.waitFor(() => { fixture.detectChanges(); expect(element.textContent).toContain('Starting…'); });
    expect(taskAppApprove).toHaveBeenCalledExactlyOnceWith('machine', 2, 'request');
    expect(fixture.componentInstance.setupHelperPath()).toBe('');
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
      expect(view.nativeElement.textContent).toContain('That app isn\'t available');
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

  describe('recovery guidance', () => {
    const mount = (bridge: object, remote = true) => {
      TestBed.configureTestingModule({ providers: [{ provide: ELEVENEX_BRIDGE, useValue: bridge }] });
      const fixture = TestBed.createComponent(TaskAppsComponent);
      fixture.componentRef.setInput('scopeId', 'machine');
      fixture.componentRef.setInput('taskId', 5);
      fixture.componentRef.setInput('machine', 'Studio Mac');
      fixture.componentRef.setInput('remote', remote);
      fixture.detectChanges();
      const element: HTMLElement = fixture.nativeElement;
      const button = (name: string) => [...element.querySelectorAll('button')].find(b => b.textContent?.trim() === name);
      return { fixture, element, button };
    };

    it('names the unreachable machine, keeps the code behind a disclosure and retries only the read', async () => {
      let reachable = false;
      const taskAppsRead = vi.fn(async (): Promise<BackendResult<readonly TaskAppRun[]>> => reachable
        ? { ok: true, value: [run(5, 'web')] }
        : { ok: false, error: { code: 'transport', message: 'Backend connection failed.' } });
      const { fixture, element, button } = mount({ taskAppsRead });
      await vi.waitFor(() => { fixture.detectChanges(); expect(element.querySelector('.state h2')?.textContent).toBe('Can\'t reach Studio Mac'); });
      expect(element.querySelector('.state')?.getAttribute('role')).toBe('alert');
      expect(element.querySelector('.state p')?.textContent).not.toContain('Backend connection failed.');
      expect(element.querySelector('.diagnostic')?.textContent).toContain('transport · Backend connection failed.');
      reachable = true;
      button('Try again')!.click();
      await vi.waitFor(() => { fixture.detectChanges(); expect(element.querySelector('[role=tab]')?.textContent?.trim()).toBe('Preview web'); });
      expect(element.textContent).not.toContain('Can\'t reach Studio Mac');
    });

    it('treats a stop whose reply was lost as unknown, refreshes, and drops the warning once the run has ended', async () => {
      let state: TaskAppRun = run(5, 'web');
      const taskAppsRead = vi.fn(async () => ({ ok: true as const, value: [state] }));
      const taskAppStop = vi.fn(async (): Promise<BackendResult<void>> => {
        state = { ...state, status: 'exited', detail: 'Stopped' };
        return { ok: false, error: { code: 'outcome-unknown', message: 'The operation may have completed.' } };
      });
      const { fixture, element } = mount({ taskAppsRead, taskAppStop });
      await vi.waitFor(() => { fixture.detectChanges(); expect(element.querySelector('button[aria-label="Stop app"]')).not.toBeNull(); });
      const reads = taskAppsRead.mock.calls.length;
      element.querySelector<HTMLButtonElement>('button[aria-label="Stop app"]')!.click();
      // The refresh that follows a stop makes the run's real state authoritative.
      await vi.waitFor(() => { fixture.detectChanges(); expect(taskAppsRead.mock.calls.length).toBeGreaterThan(reads); expect(element.querySelector('.state h2')?.textContent).toBe('App exited'); });
      expect(element.querySelector('[role=alert]')).toBeNull();
      expect(taskAppStop).toHaveBeenCalledTimes(1);
    });

    it('does not say setup opened when the host could not confirm it', async () => {
      const setupRun: TaskAppRun = { ...run(5, 'web'), status: 'requested', setupIssue: 'macos-screen-recording', pendingLaunch: { executable: 'pnpm', args: ['dev'] } };
      const taskAppsRead = vi.fn(async () => ({ ok: true as const, value: [setupRun] }));
      const taskAppOpenSetupSettings = vi.fn(async (): Promise<BackendResult<void>> => ({ ok: false, error: { code: 'outcome-unknown', message: 'The operation may have completed.' } }));
      const { fixture, element, button } = mount({ taskAppsRead, taskAppOpenSetupSettings });
      await vi.waitFor(() => { fixture.detectChanges(); expect(button('Open setup on host')).toBeDefined(); });
      button('Open setup on host')!.click();
      await vi.waitFor(() => { fixture.detectChanges(); expect(element.querySelector('[role=alert]')?.textContent).toContain('Couldn\'t confirm Elevenex Agent setup opened'); });
      expect(element.querySelector('[role=alert]')?.textContent).toContain('Studio Mac');
      expect(element.textContent).not.toContain('was asked to open');
    });

    it('says plainly that SSH desktop access still needs repair after permissions, and speaks of this Mac locally', async () => {
      const issue: TaskAppRun = { ...run(5, 'web'), status: 'failed', setupIssue: 'macos-desktop-connection', detail: 'macOS refused the desktop connection.' };
      const taskAppsRead = vi.fn(async () => ({ ok: true as const, value: [issue] }));
      const remote = mount({ taskAppsRead, taskAppOpenSetupSettings: vi.fn() });
      await vi.waitFor(() => { remote.fixture.detectChanges(); expect(remote.element.querySelector('ex-task-app-setup')).not.toBeNull(); });
      expect(remote.element.textContent).toContain('does not repair the SSH desktop connection by itself');
      expect(remote.element.textContent).toContain('Someone there needs to complete them');
      expect(remote.element.querySelector('.diagnostic')?.textContent).toContain('macOS refused the desktop connection.');
      TestBed.resetTestingModule();
      const local = mount({ taskAppsRead, taskAppOpenSetupSettings: vi.fn() }, false);
      await vi.waitFor(() => { local.fixture.detectChanges(); expect(local.element.querySelector('ex-task-app-setup')).not.toBeNull(); });
      expect(local.element.textContent).toContain('this Mac');
      expect(local.element.textContent).not.toContain('Someone there needs to complete them');
      expect(local.element.textContent).toContain('Open setup');
    });

    it('explains a missing operation instead of silently disabling a launch', async () => {
      const proposal: TaskAppRun = { ...run(5, 'web'), status: 'requested', pendingLaunch: { executable: 'pnpm', args: ['dev'] } };
      const { fixture, element } = mount({ taskAppsRead: vi.fn(async () => ({ ok: true as const, value: [proposal] })) });
      await vi.waitFor(() => { fixture.detectChanges(); expect(element.querySelector('.approval')).not.toBeNull(); });
      expect(element.querySelector('.approval .note')?.textContent).toContain('can\'t launch apps');
      expect(element.querySelector<HTMLButtonElement>('.approval button[data-variant=primary]')!.disabled).toBe(true);
    });

    it('keeps a failed log read apart from the output and offers a retry', async () => {
      let readable = false;
      const taskAppOutput = vi.fn(async (): Promise<BackendResult<string>> => readable
        ? { ok: true, value: 'ready' } : { ok: false, error: { code: 'transport', message: 'Backend connection failed.' } });
      const { fixture, element } = mount({ taskAppsRead: vi.fn(async () => ({ ok: true as const, value: [run(5, 'web')] })), taskAppOutput });
      await vi.waitFor(() => { fixture.detectChanges(); expect(element.querySelector('.tools button[aria-label=Logs]')).not.toBeNull(); });
      element.querySelector<HTMLButtonElement>('.tools button[aria-label=Logs]')!.click();
      await vi.waitFor(() => { fixture.detectChanges(); expect(element.querySelector('.logs-problem')?.textContent).toContain('Couldn\'t load output'); });
      expect(element.querySelector('.logs pre')?.textContent).toBe('No output loaded.');
      readable = true;
      element.querySelector<HTMLButtonElement>('.logs-problem button')!.click();
      await vi.waitFor(() => { fixture.detectChanges(); expect(element.querySelector('.logs pre')?.textContent).toBe('ready'); });
      expect(element.querySelector('.logs-problem')).toBeNull();
    });
  });
});
