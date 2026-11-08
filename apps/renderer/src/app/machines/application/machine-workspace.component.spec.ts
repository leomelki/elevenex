import { SessionChatDrafts } from '../../session-chat/session-chat-drafts';
import type { BackendResult, ElevenexBridge } from '@elevenex/shared';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { ConnectedWorkspaceFixture } from '../../../../preview/connected-workspace-fixture';
import { BackendClientService, ELEVENEX_BRIDGE } from '../../backend/backend-client.service';
import { MachineWorkspaceComponent } from './machine-workspace.component';

async function settle(fixture: ComponentFixture<MachineWorkspaceComponent>): Promise<void> {
  for (let pass = 0; pass < 40; pass++) { await Promise.resolve(); fixture.detectChanges(); }
  await fixture.whenStable();
}
function setup(terminalOpen?: ElevenexBridge['taskTerminalOpenPort'], terminalCopy?: ElevenexBridge['taskTerminalCopyPort']) {
  TestBed.configureTestingModule({ providers: [ConnectedWorkspaceFixture, BackendClientService, {
    provide: ELEVENEX_BRIDGE, useFactory: (platform: ConnectedWorkspaceFixture) => Object.assign(platform,
      terminalOpen ? { taskTerminalOpenPort: terminalOpen } : {}, terminalCopy ? { taskTerminalCopyPort: terminalCopy } : {}),
    deps: [ConnectedWorkspaceFixture],
  }] });
  const fixture = TestBed.createComponent(MachineWorkspaceComponent);
  fixture.componentRef.setInput('machine', { id: 'local', name: 'This Mac', kind: 'local', conn: 'live' });
  fixture.componentRef.setInput('active', true);
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, platform: TestBed.inject(ConnectedWorkspaceFixture), root: fixture.nativeElement as HTMLElement };
}

describe('Connected workspace composition', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: !query.includes('max-width'), addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }));
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('retains the selected Changes review through an inert closing slide, then disposes it', async () => {
    const {fixture,component,root}=setup(); await settle(fixture);
    component.store.selectSession({taskId:'11',sessionId:'101'}); await settle(fixture);
    const selected=component.store.selected(); if (!selected) throw new Error('Session was not selected');
    component.review({...selected,turnId:'turn-one'}); component.wideReview.set(true); await settle(fixture);
    const review=root.querySelector('ex-session-chat-review'); expect(review).not.toBeNull();
    const panel=root.querySelector<HTMLElement>('ex-app-shell .panel'); if (!panel) throw new Error('Panel was not mounted');
    let finish!: () => void;
    const finished=new Promise<void>(resolve=>{finish=resolve;});
    Object.defineProperty(panel,'getAnimations',{value:()=>[{transitionProperty:'width',finished}]});
    component.closePanel(); await settle(fixture);
    await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
    expect(root.querySelector('ex-session-chat-review')).toBe(review);
    expect(panel.hasAttribute('inert')).toBe(true);
    finish(); await Promise.resolve(); await settle(fixture);
    expect(root.querySelector('ex-session-chat-review')).toBeNull();
  });

  it('loads navigation and the task header, retaining a read-only view behind Home', async () => {
    const { fixture, component, root } = setup();
    await settle(fixture);
    expect(component.store.projects()).toHaveLength(2);
    expect(root.querySelector('ex-title-bar')).toBeNull();
    component.store.selectSession({ taskId: '11', sessionId: '101' });
    await settle(fixture);
    expect(root.querySelector('ex-workspace-task-header')).not.toBeNull();
    expect(root.querySelector('ex-chat')).not.toBeNull();
    expect(root.querySelector('ex-composer')).not.toBeNull();
    expect(root.querySelector('textarea')).not.toBeNull();
    expect(root.querySelector('ex-session-chat .provider')?.textContent).toContain('Codex');
    fixture.componentRef.setInput('active', false);
    await settle(fixture);
    expect(component.store.selected()?.sessionId).toBe(101);
    expect(component.store.projects()).toHaveLength(2);
    expect(root.hasAttribute('inert')).toBe(true);
  });

  for (const dispose of [false, true]) it(`prepares navigation while inert and ${dispose ? 'cancels its paint notification on destruction' : 'acknowledges the paint boundary'}`, async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++nextFrame, callback); return nextFrame; });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
    const { fixture, component, root } = setup();
    fixture.componentRef.setInput('active', false);
    fixture.componentRef.setInput('preparing', true);
    const prepared = vi.fn(); component.prepared.subscribe(prepared);
    await settle(fixture);
    expect(component.store.projects()).toHaveLength(2);
    expect(root.hasAttribute('inert')).toBe(true);
    expect(prepared).not.toHaveBeenCalled();
    const firstPaint = [...frames.entries()];
    for (const [id, callback] of firstPaint) { frames.delete(id); callback(0); }
    expect(prepared).not.toHaveBeenCalled();
    if (dispose) { fixture.destroy(); expect(cancel).toHaveBeenCalled(); }
    for (const callback of [...frames.values()]) callback(16);
    if (dispose) expect(prepared).not.toHaveBeenCalled();
    else {
      expect(prepared).toHaveBeenCalledExactlyOnceWith({ machineId: 'local', generation: 0 });
      frames.clear();
      fixture.componentRef.setInput('generation', 1);
      await settle(fixture);
      for (const [id, callback] of [...frames.entries()]) { frames.delete(id); callback(32); }
      for (const callback of [...frames.values()]) callback(48);
      expect(prepared).toHaveBeenLastCalledWith({ machineId: 'local', generation: 1 });
      expect(prepared).toHaveBeenCalledTimes(2);
    }
  });

  it('opens wider review with its shortcut and restores the main region with Escape', async () => {
    const { fixture, component, root } = setup();
    await settle(fixture);
    component.store.selectSession({ taskId: '11', sessionId: '101' });
    await settle(fixture);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'R', ctrlKey: true, shiftKey: true, bubbles: true }));
    await settle(fixture);
    expect(component.panelOpen()).toBe(true);
    expect(component.wideReview()).toBe(true);
    expect(root.querySelector('main')?.hasAttribute('inert')).toBe(true);
    root.querySelector('ex-app-shell')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(fixture);
    expect(component.wideReview()).toBe(false);
    expect(root.querySelector('main')?.hasAttribute('inert')).toBe(false);
    component.closePanel();
    await settle(fixture);
    expect(root.querySelector('.panel')?.hasAttribute('inert')).toBe(true);
  });

  it('resumes the project, conversation and panel after recreating the workspace, and keeps each backend separate', async () => {
    const { fixture, component, platform } = setup();
    await settle(fixture);
    await component.store.selectProject('1');
    component.store.selectSession({ taskId: '11', sessionId: '102' });
    component.panel.set('browser'); component.panelOpen.set(true);
    await settle(fixture);
    fixture.destroy();
    const reopened = TestBed.createComponent(MachineWorkspaceComponent);
    reopened.componentRef.setInput('machine', { id: 'local', name: 'This Mac', kind: 'local', conn: 'live' });
    reopened.componentRef.setInput('active', true);
    await settle(reopened);
    const owner = reopened.componentInstance;
    expect(owner.store.activeProject()).toBe('1');
    expect(owner.store.selected()?.sessionId).toBe(102);
    expect(owner.panel()).toBe('browser'); expect(owner.panelOpen()).toBe(true);

    const host = await platform.saveRemoteHost({ name: 'Other backend', host: 'dev' });
    await platform.selectEnvironment({ kind: 'remote', hostId: host.id }); platform.ready();
    reopened.componentRef.setInput('machine', { id: host.id, name: host.name, kind: 'ssh', conn: 'live' });
    await settle(reopened);
    expect(owner.store.selected()).toBeNull(); expect(owner.panelOpen()).toBe(false);
    await owner.store.selectProject('2'); owner.store.selectSession({ taskId: '13', sessionId: '104' });
    owner.panel.set('changes'); owner.panelOpen.set(true); owner.wideReview.set(true);
    await settle(reopened);
    await platform.selectEnvironment({ kind: 'local' });
    reopened.componentRef.setInput('machine', { id: 'local', name: 'This Mac', kind: 'local', conn: 'live' });
    await settle(reopened);
    expect(owner.store.selected()?.sessionId).toBe(102);
    expect(owner.panel()).toBe('browser'); expect(owner.wideReview()).toBe(false);
    await platform.selectEnvironment({ kind: 'remote', hostId: host.id }); platform.ready();
    reopened.componentRef.setInput('machine', { id: host.id, name: host.name, kind: 'ssh', conn: 'live' });
    await settle(reopened);
    expect(owner.store.activeProject()).toBe('2'); expect(owner.store.selected()?.sessionId).toBe(104);
    expect(owner.panel()).toBe('changes'); expect(owner.wideReview()).toBe(true);
    expect((reopened.nativeElement as HTMLElement).querySelector('main')?.hasAttribute('inert')).toBe(true);
    expect(document.activeElement?.closest('ex-workspace-panels')).not.toBeNull();
    owner.closePanel(); await settle(reopened); reopened.destroy();
    const closed = TestBed.createComponent(MachineWorkspaceComponent);
    closed.componentRef.setInput('machine', { id: host.id, name: host.name, kind: 'ssh', conn: 'live' });
    closed.componentRef.setInput('active', true);
    await settle(closed);
    expect(closed.componentInstance.panelOpen()).toBe(false);
    expect(closed.componentInstance.wideReview()).toBe(false);
  });

  it('shows project onboarding over inert shell regions and surfaces a read failure with recovery', async () => {
    const { fixture, component, platform, root } = setup();
    await settle(fixture);
    platform.empty();
    await settle(fixture);
    expect(root.querySelector('ex-workspace-onboarding')).not.toBeNull();
    expect(root.querySelector('.workspace-frame')?.hasAttribute('inert')).toBe(true);
    platform.failure();
    await settle(fixture);
    expect(component.store.error()).toBeTruthy();
    expect(root.textContent).toContain('Workspace unavailable');
    platform.recoverWorkspace();
    await settle(fixture);
    expect(root.querySelector('ex-workspace-onboarding')).not.toBeNull();
  });
  it('stages terminal context only in the matching selected conversation and never sends it', async () => {
    const { fixture, component, platform } = setup(); await settle(fixture);
    component.store.selectSession({ taskId: '11', sessionId: '101' }); await settle(fixture);
    const selected = component.store.selected()!;
    const entry = fixture.debugElement.injector.get(SessionChatDrafts).entry(selected.scopeId, selected.sessionId);
    entry.text.set('Keep this writing.');
    const question = { scopeId: selected.scopeId, taskId: selected.taskId, command: 'npm test', code: 7, output: 'failure context' };
    component.askTerminal({ ...question, scopeId: 'stale-scope' });
    expect(entry.text()).toBe('Keep this writing.');
    component.askTerminal(question); await settle(fixture);
    expect(entry.text()).toContain('Keep this writing.'); expect(entry.text()).toContain('failure context');
    expect(platform.sentChatActions).toHaveLength(0);
  });

  it.each(['reply', 'throw'])('opens a newly selected terminal service during an earlier launch and ignores its failed %s', async mode => {
    const pending: { resolve: (reply: BackendResult<{ readonly accepted: true }>) => void; reject: (error: Error) => void }[] = [];
    const open = vi.fn<ElevenexBridge['taskTerminalOpenPort']>(() => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }));
    const { fixture, component } = setup(open); await settle(fixture);
    component.store.selectSession({ taskId: '11', sessionId: '101' }); await settle(fixture);
    const selected = component.store.selected()!;
    const first = { scopeId: selected.scopeId, taskId: selected.taskId, terminalId: 1, port: 3000 };
    const second = { ...first, terminalId: 2, port: 4000 };
    component.openTerminalPort(first);
    component.openTerminalPort(second);
    expect(open).toHaveBeenCalledTimes(2);
    if (mode === 'throw') pending[0]!.reject(new Error('Earlier failure'));
    else pending[0]!.resolve({ ok: false, error: { code: 'transport', message: 'Earlier failure' } });
    await settle(fixture);
    expect(component.terminalBrowserBusy()).toBe(true);
    expect(component.terminalBrowserError()).toBe('');
    pending[1]!.resolve({ ok: true, value: { accepted: true } }); await settle(fixture);
    expect(component.terminalBrowserBusy()).toBe(false);
    expect(component.selectedTerminalBrowser()).toBe(second);
  });

  it('opens the external browser once, keeps Terminal visible and exposes its actual forwarded address', async () => {
    let finish!: (reply: BackendResult<{ readonly accepted: true; readonly url?: string }>) => void;
    const open = vi.fn<ElevenexBridge['taskTerminalOpenPort']>(() => new Promise(resolve => { finish = resolve; }));
    const { fixture, component } = setup(open); await settle(fixture);
    component.store.selectSession({ taskId: '11', sessionId: '101' }); await settle(fixture);
    component.store.selectPanel('terminal'); component.panelOpen.set(true);
    const selected = component.store.selected()!;
    const intent = { scopeId: selected.scopeId, taskId: selected.taskId, terminalId: 1, port: 4200 };
    component.openTerminalPort(intent);
    component.openTerminalPort({ ...intent });
    expect(open).toHaveBeenCalledExactlyOnceWith(selected.scopeId, { taskId: selected.taskId, terminalId: 1, port: 4200 });
    expect(component.panel()).toBe('terminal'); expect(component.panelOpen()).toBe(true);
    expect(component.terminalBrowserState()?.busy).toBe(true);
    finish({ ok: true, value: { accepted: true, url: 'http://127.0.0.1:24567/app/' } });
    await settle(fixture);
    expect(component.terminalBrowserState()).toEqual({ terminalId: 1, port: 4200, busy: false, error: '', url: 'http://127.0.0.1:24567/app/' });
    component.store.selectSession({ taskId: '13', sessionId: '104' }); await settle(fixture);
    expect(component.terminalBrowserState()).toBeNull();
  });

  it('copies the resolved forwarded URL without opening the browser, with failure and retry feedback', async () => {
    const open = vi.fn<ElevenexBridge['taskTerminalOpenPort']>();
    const copy = vi.fn<ElevenexBridge['taskTerminalCopyPort']>(async () => ({ ok: true, value: { accepted: true, url: 'https://127.0.0.1:24567/app/' } }))
      .mockResolvedValueOnce({ ok: false, error: { code: 'transport', message: 'Could not copy the URL.' } });
    const { fixture, component } = setup(open, copy); await settle(fixture);
    component.store.selectSession({ taskId: '11', sessionId: '101' }); await settle(fixture);
    const selected = component.store.selected()!;
    const intent = { scopeId: selected.scopeId, taskId: selected.taskId, terminalId: 1, port: 4200 };
    component.openTerminalPort(intent, true);
    expect(component.terminalBrowserState()?.copyBusy).toBe(true);
    component.openTerminalPort({ ...intent }, true);
    await settle(fixture);
    expect(copy).toHaveBeenCalledExactlyOnceWith(selected.scopeId, { taskId: selected.taskId, terminalId: 1, port: 4200 });
    expect(open).not.toHaveBeenCalled();
    expect(component.terminalBrowserState()?.copied).toBeUndefined();
    expect(component.terminalBrowserState()?.error).toContain('Could not copy');
    component.openTerminalPort({ ...intent }, true); await settle(fixture);
    expect(component.terminalBrowserState()).toMatchObject({ copied: true, busy: false, error: '', url: 'https://127.0.0.1:24567/app/' });
    expect(open).not.toHaveBeenCalled();
  });

  it('ignores late copy feedback after switching tasks', async () => {
    let finish!: (reply: Awaited<ReturnType<ElevenexBridge['taskTerminalCopyPort']>>) => void;
    const resolve = vi.fn<ElevenexBridge['taskTerminalCopyPort']>(() => new Promise(done => { finish = done; }));
    const { fixture, component } = setup(undefined, resolve); await settle(fixture);
    component.store.selectSession({ taskId: '11', sessionId: '101' }); await settle(fixture);
    const selected = component.store.selected()!;
    component.openTerminalPort({ scopeId: selected.scopeId, taskId: selected.taskId, terminalId: 1, port: 4200 }, true);
    component.store.selectSession({ taskId: '13', sessionId: '104' }); await settle(fixture);
    finish({ ok: true, value: { accepted: true, url: 'http://127.0.0.1:24567/' } }); await settle(fixture);
    expect(component.terminalCopied()).toBe(false); expect(component.terminalBrowserState()).toBeNull();
  });

});
