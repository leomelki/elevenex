import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { ConnectedWorkspaceFixture } from '../../../../preview/connected-workspace-fixture';
import { BackendClientService, ELEVENEX_BRIDGE } from '../../backend/backend-client.service';
import { MachineWorkspaceComponent } from './machine-workspace.component';

async function settle(fixture: ComponentFixture<MachineWorkspaceComponent>): Promise<void> {
  for (let pass = 0; pass < 40; pass++) { await Promise.resolve(); fixture.detectChanges(); }
  await fixture.whenStable();
}
function setup() {
  TestBed.configureTestingModule({ providers: [ConnectedWorkspaceFixture, BackendClientService, { provide: ELEVENEX_BRIDGE, useExisting: ConnectedWorkspaceFixture }] });
  const fixture = TestBed.createComponent(MachineWorkspaceComponent);
  fixture.componentRef.setInput('machine', { id: 'local', name: 'This Mac', kind: 'local', conn: 'live' });
  fixture.componentRef.setInput('active', true);
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, platform: TestBed.inject(ConnectedWorkspaceFixture), root: fixture.nativeElement as HTMLElement };
}

describe('Connected workspace composition', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }));
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('loads navigation and the task header, and clears scoped selection on exit', async () => {
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
    expect(root.querySelector('ex-session-chat .provider')?.textContent).toContain('codex');
    fixture.componentRef.setInput('active', false);
    await settle(fixture);
    expect(component.store.selected()).toBeNull();
    expect(component.store.projects()).toEqual([]);
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
});
