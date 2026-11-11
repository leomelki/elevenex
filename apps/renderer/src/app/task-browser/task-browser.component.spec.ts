import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskBrowserCommand, TaskBrowserPlacement, TaskBrowserState, TaskBrowserTab, TaskBrowserWindowContext, ElevenexBridge } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { TaskBrowserComponent } from './task-browser.component';

function tab(id = 'tab-1'): TaskBrowserTab {
  return { id, title: 'New tab', url: '', by: 'you', driver: 'you', agentSessionId: null, generation: 1, loading: false, ready: false, canGoBack: false, error: null, errors: 0, width: 'full', theme: 'system', slowNetwork: false, waiting: false };
}
function setup(tabs: readonly TaskBrowserTab[] = [], availablePlacements?: readonly TaskBrowserPlacement[], picked: TaskBrowserState['picked'] = null) {
  let state: TaskBrowserState = { availablePlacements, placement: 'desktop', scopeId: 'scope', taskId: 1, revision: 0, surfaceEpoch: 0, controlsFocus: 0, active: tabs[0]?.id ?? null, tabs, picked, picking: false, pickerMessage: null, feedback: false, ports: [3000], privacy: 'content-withheld' };
  const bridge = {
    taskBrowserDetach: vi.fn<NonNullable<ElevenexBridge['taskBrowserDetach']>>(async () => undefined),
    taskBrowserReturn: vi.fn<NonNullable<ElevenexBridge['taskBrowserReturn']>>(async () => undefined),
    taskBrowserRead: vi.fn(async () => ({ ok: true, value: state })),
    taskBrowserConfigure: vi.fn(async (_scope: string, _task: number, placement: TaskBrowserPlacement) => {
      state = { ...state, placement, revision: 0 };
      return { ok: true, value: state };
    }),
    taskBrowserHide: vi.fn(async () => undefined),
    taskBrowserCommand: vi.fn(async (_scope: string, _task: number, input: TaskBrowserCommand) => {
      if (input.kind === 'new-tab') {
        const next = tab('tab-' + (state.revision + 1));
        state = { ...state, revision: state.revision + 1, tabs: [...state.tabs, next], active: next.id };
      } else if (input.kind === 'close') state = { ...state, revision: state.revision + 1, tabs: [], active: null };
      return { ok: true, value: state };
    }),
  };
  TestBed.configureTestingModule({ providers: [{ provide: ELEVENEX_BRIDGE, useValue: bridge }] });
  const fixture = TestBed.createComponent(TaskBrowserComponent);
  fixture.componentRef.setInput('scopeId', 'scope');
  fixture.componentRef.setInput('taskId', 1);
  return { fixture, bridge };
}
async function render(fixture: ComponentFixture<TaskBrowserComponent>): Promise<void> {
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(fixture.componentInstance.store.pending()).toBe(0);
    expect(fixture.nativeElement.querySelector('ex-browser-view')).not.toBeNull();
  });
}
afterEach(() => TestBed.resetTestingModule());
describe('Browser responsiveness controls', () => {
  it('offers explicit recovery for a loading remote page only on capable hosts', async () => {
    const { fixture, bridge } = setup([{ ...tab(), execution: 'remote', url: 'https://example.com', loading: true }]);
    fixture.componentRef.setInput('active', true);
    await render(fixture);
    fixture.componentInstance.showDialog('tools'); fixture.detectChanges();
    const recovery = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(button => button.textContent?.trim() === 'Force reload page');
    expect(recovery()).toBeUndefined();
    fixture.componentInstance.store.state.update(state => state && { ...state, canRecover: true });
    fixture.detectChanges();
    expect(recovery()?.disabled).toBe(false);
    recovery()?.click();
    expect(bridge.taskBrowserCommand).toHaveBeenCalledWith('scope', 1, { kind: 'recover', tabId: 'tab-1' });
  });
  it('keeps new-tab input enabled during a slow page command', async () => {
    const { fixture, bridge } = setup([{ ...tab(), url: 'https://example.com' }]);
    await render(fixture);
    fixture.componentInstance.store.pending.set(1);
    fixture.detectChanges();
    const add = fixture.nativeElement.querySelector('[aria-label="New browser tab (⌘T)"]') as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    add.click();
    expect(bridge.taskBrowserCommand).toHaveBeenCalledWith('scope', 1, { kind: 'new-tab' });
  });
});
describe('Point at an element for the chat', () => {
  it('renders host hover geometry only while pointing and drops it on cancellation', async () => {
    const { fixture } = setup([{ ...tab(), url: 'http://localhost:3000', ready: true }]);
    await render(fixture);
    fixture.componentInstance.store.state.update(state => state && { ...state, picking: true, tabs: state.tabs.map(tab => ({ ...tab, hovered: { x: 20, y: 30, width: 100, height: 40, tag: 'button' } })) });
    fixture.detectChanges();
    const ring = fixture.nativeElement.querySelector('.target.hover') as HTMLElement;
    expect(ring.textContent).toContain('button');
    expect(ring.style.width).toBe('108px');
    expect(ring.style.height).toBe('48px');
    fixture.componentInstance.store.state.update(state => state && { ...state, picking: false });
    fixture.detectChanges();
    expect(fixture.componentInstance.hovered()).toBeUndefined();
    expect(fixture.nativeElement.querySelector('.target.hover')).toBeNull();
  });
  const element = { selector: 'css=[data-elevenex-picked="11111111-1111-4111-8111-111111111111"]', tag: 'button', x: 20, y: 20, width: 100, height: 30 };
  const snapshot = { reference: { version: 1 as const, id: '11111111-1111-4111-8111-111111111111', label: 'button · Save', selector: element.selector, tag: 'button', frames: [], page: 'http://localhost:3000/', tabId: 'tab-1', documentId: 'document-1', capturedAt: '2026-11-09T10:00:00Z', target: element, crop: { x: 0, y: 0, width: 200, height: 100 }, image: { width: 200, height: 100, scale: 1 } }, jpeg: '/9j/' };
  it('stages a pick in the chat directly, as a snapshot rather than prose', async () => {
    const { fixture, bridge } = setup([{ ...tab(), url: 'http://localhost:3000', ready: true }], undefined, { ...element, snapshot });
    fixture.componentRef.setInput('sessionId', 2); fixture.componentRef.setInput('active', true);
    const emit = vi.fn(); fixture.componentInstance.contextRequested.subscribe(emit);
    await render(fixture);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ scopeId: 'scope', taskId: 1, sessionId: 2, text: '', element: snapshot });
    expect(fixture.nativeElement.querySelector('form.question')).toBeNull();
    fixture.componentInstance.contextStaged(emit.mock.calls[0]![0], 1);
    expect(bridge.taskBrowserCommand).toHaveBeenCalledWith('scope', 1, { kind: 'pick', enabled: false });
    expect(fixture.componentInstance.notice()).toBe('');
    fixture.detectChanges();
    expect(emit).toHaveBeenCalledTimes(1);
  });
  it('explains a pick the chat could not stage and releases the picker', async () => {
    const { fixture, bridge } = setup([{ ...tab(), url: 'http://localhost:3000', ready: true }], undefined, { ...element, snapshot });
    fixture.componentRef.setInput('sessionId', 2); fixture.componentRef.setInput('active', true);
    const emit = vi.fn(); fixture.componentInstance.contextRequested.subscribe(emit);
    await render(fixture);
    fixture.componentInstance.contextStaged(emit.mock.calls[0]![0], null);
    expect(fixture.componentInstance.notice()).toContain('Could not add');
    expect(bridge.taskBrowserCommand).toHaveBeenCalledWith('scope', 1, { kind: 'pick', enabled: false });
  });
  it('does not start a re-pick on another tab after the original tab selection fails', async () => {
    const { fixture } = setup([tab(), tab('tab-2')]); await render(fixture);
    const command = vi.spyOn(fixture.componentInstance.store, 'command').mockResolvedValueOnce(false);
    await fixture.componentInstance.beginElementPick('tab-2');
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith({ kind: 'select', tabId: 'tab-2' });
  });
  it('picks on the current page when no tab is named, and explains when there is none', async () => {
    const empty = setup([]);
    await vi.waitFor(() => { empty.fixture.detectChanges(); expect(empty.fixture.componentInstance.store.state()).not.toBeNull(); });
    vi.spyOn(empty.fixture.componentInstance.store, 'command').mockResolvedValue(true);
    empty.fixture.componentInstance.store.state.update(state => state && { ...state, tabs: [], active: null });
    await empty.fixture.componentInstance.beginElementPick();
    expect(empty.fixture.componentInstance.notice()).toContain('Open a page');
    TestBed.resetTestingModule();
    const { fixture } = setup([tab()]); await render(fixture);
    const command = vi.spyOn(fixture.componentInstance.store, 'command').mockResolvedValue(true);
    await fixture.componentInstance.beginElementPick();
    expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'pick', enabled: true });
  });
  it('explains missing capture without pretending an image was staged', async () => {
    const { fixture } = setup([tab()], undefined, element);
    fixture.componentRef.setInput('sessionId', 2);
    const emit = vi.fn(); fixture.componentInstance.contextRequested.subscribe(emit);
    await render(fixture);
    expect(emit).not.toHaveBeenCalled();
    expect(fixture.componentInstance.notice()).toContain('cannot capture');
  });
  it('rejects a pick that lands after the conversation changed', async () => {
    const { fixture } = setup([tab()]);
    fixture.componentRef.setInput('sessionId', 2); await render(fixture);
    fixture.componentInstance.command({ kind: 'pick', enabled: true });
    fixture.componentRef.setInput('sessionId', 3); fixture.detectChanges();
    const emit = vi.fn(); fixture.componentInstance.contextRequested.subscribe(emit);
    fixture.componentInstance.store.state.update(state => state && { ...state, revision: state.revision + 1, picked: { ...element, snapshot } });
    fixture.detectChanges();
    expect(emit).not.toHaveBeenCalled();
    expect(fixture.componentInstance.notice()).toContain('conversation changed');
  });
});
describe('Browser location controls', () => {
  it('keeps local tasks native without a display-mode choice', async () => {
    const { fixture } = setup([tab()], ['desktop']);
    fixture.componentRef.setInput('active', true); await render(fixture);
    fixture.componentInstance.showDialog('tools'); fixture.detectChanges();
    const location = document.querySelector<HTMLButtonElement>('[aria-label="Browser location: Local"]');
    expect(location?.disabled).toBe(true);
    const buttons = [...document.querySelectorAll('[role="dialog"] button')].map(button => button.textContent?.trim());
    expect(buttons).not.toContain('Direct');
    expect(buttons).not.toContain('Stream');
  });
  it('uses Local and Remote to switch browser hosts', async () => {
    const { fixture, bridge } = setup([tab()], ['desktop', 'desktop-proxy', 'machine']);
    fixture.componentRef.setInput('active', true); await render(fixture);
    fixture.componentInstance.showDialog('tools'); fixture.detectChanges();
    document.querySelector<HTMLButtonElement>('[aria-label="Browser location: Local"]')?.click(); fixture.detectChanges();
    const remote = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(button => button.textContent?.trim().startsWith('Remote'));
    expect(remote).toBeDefined();
    remote?.click(); await render(fixture);
    expect(bridge.taskBrowserConfigure).toHaveBeenCalledExactlyOnceWith('scope', 1, 'machine');
    expect(document.querySelector('[aria-label="Browser location: Remote"]')).not.toBeNull();
  });
});
describe('Task browser start tabs', () => {
  it.each([undefined, false, true])('enables Forward only with forward history (%s)', async canGoForward => {
    const { fixture, bridge } = setup([{ ...tab(), canGoForward }]);
    fixture.componentRef.setInput('active', true); await render(fixture);
    const forward = fixture.nativeElement.querySelector('[aria-label="Forward"]') as HTMLButtonElement;
    expect(forward.disabled).toBe(canGoForward !== true);
    forward.click(); await render(fixture);
    if (canGoForward) expect(bridge.taskBrowserCommand).toHaveBeenCalledExactlyOnceWith('scope', 1, { kind: 'forward', tabId: 'tab-1' });
    else expect(bridge.taskBrowserCommand).not.toHaveBeenCalled();
  });
  it('keeps the page slot clear of replacement content during navigation', async () => {
    const { fixture } = setup([{ ...tab(), url: 'https://example.com/next', loading: true }]);
    fixture.componentRef.setInput('active', true); await render(fixture);
    expect(fixture.nativeElement.querySelector('.native-page')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.page-state')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Loading page');
  });
  it('waits until the browser is active, then creates one start tab with address focus', async () => {
    const { fixture, bridge } = setup();
    await render(fixture);
    expect(bridge.taskBrowserCommand).not.toHaveBeenCalled();
    fixture.componentRef.setInput('active', true); await render(fixture);
    expect(bridge.taskBrowserCommand).toHaveBeenCalledExactlyOnceWith('scope', 1, { kind: 'new-tab' });
    expect(fixture.nativeElement.querySelector('.start-page')?.textContent).toContain('Where would you like to go?');
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('[aria-label="Page address"]'));
    await render(fixture);
    expect(bridge.taskBrowserCommand).toHaveBeenCalledTimes(1);
  });
  it('adds tabs immediately from + and the keyboard, and navigates in the selected tab', async () => {
    const { fixture, bridge } = setup();
    fixture.componentRef.setInput('active', true); await render(fixture);
    (fixture.nativeElement.querySelector('[aria-label="New browser tab (⌘T)"]') as HTMLButtonElement).click();
    await render(fixture);
    expect(fixture.componentInstance.store.state()?.tabs).toHaveLength(2);
    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeNull();
    const address = fixture.nativeElement.querySelector('[aria-label="Page address"]') as HTMLInputElement;
    expect(document.activeElement).toBe(address);
    address.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true }));
    await render(fixture);
    expect(fixture.componentInstance.store.state()?.tabs).toHaveLength(3);
    address.value = '3000'; address.dispatchEvent(new Event('input')); fixture.detectChanges();
    address.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await render(fixture);
    expect(bridge.taskBrowserCommand).toHaveBeenLastCalledWith('scope', 1, { kind: 'navigate', tabId: 'tab-3', url: 'http://localhost:3000' });
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('[aria-label="Page preview"]'));
  });
  it('keeps address focus when Enter has no destination', async () => {
    const { fixture, bridge } = setup([tab()]);
    fixture.componentRef.setInput('active', true); await render(fixture);
    const address = fixture.nativeElement.querySelector('[aria-label="Page address"]') as HTMLInputElement;
    address.value = '   '; address.dispatchEvent(new Event('input')); fixture.detectChanges();
    address.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await render(fixture);
    expect(bridge.taskBrowserCommand).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(address);
  });
  it('retains existing tabs and creates a default again only on returning to an empty browser', async () => {
    const { fixture, bridge } = setup([tab('existing')]);
    fixture.componentRef.setInput('active', true); await render(fixture);
    expect(bridge.taskBrowserCommand).not.toHaveBeenCalled();
    await fixture.componentInstance.store.command({ kind: 'close', tabId: 'existing' });
    await render(fixture);
    expect(bridge.taskBrowserCommand).toHaveBeenCalledTimes(1);
    fixture.componentRef.setInput('active', false); fixture.detectChanges();
    fixture.componentRef.setInput('active', true); await render(fixture);
    expect(bridge.taskBrowserCommand).toHaveBeenLastCalledWith('scope', 1, { kind: 'new-tab' });
  });
  it('does not replay a default-tab mutation after an interrupted result', async () => {
    const { fixture, bridge } = setup();
    bridge.taskBrowserCommand.mockRejectedValue(new Error('Disconnected'));
    fixture.componentRef.setInput('active', true); await render(fixture);
    await fixture.componentInstance.store.read(); await render(fixture);
    expect(bridge.taskBrowserCommand).toHaveBeenCalledTimes(1);
    expect(fixture.componentInstance.store.error()).toContain('interrupted');
  });
});


describe('Detached browser tab intents', () => {
  const context: TaskBrowserWindowContext = { projectName: 'Shop', taskName: 'Checkout', branchName: 'feat/checkout', machineName: 'This Mac', stage: 'active', hue: 'pine' };
  it('opens the current tab with captured task context', async () => {
    const { fixture, bridge } = setup([tab('existing')]);
    fixture.componentRef.setInput('windowContext', context); await render(fixture);
    (fixture.nativeElement.querySelector('[aria-label="Open tab in new window"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(bridge.taskBrowserDetach).toHaveBeenCalledExactlyOnceWith('scope', 1, 'existing', context));
    expect(bridge.taskBrowserCommand).not.toHaveBeenCalled();
  });
  it('keeps detached tabs discoverable without enabling duplicate page controls', async () => {
    const { fixture, bridge } = setup([{ ...tab('detached'), detached: true, canGoForward: true }]);
    fixture.componentRef.setInput('windowContext', context); await render(fixture);
    expect(fixture.nativeElement.querySelector('.detached-placeholder')?.textContent).toContain('Show window');
    expect((fixture.nativeElement.querySelector('[aria-label="Page address"]') as HTMLInputElement).disabled).toBe(true);
    expect((fixture.nativeElement.querySelector('[aria-label="Forward"]') as HTMLButtonElement).disabled).toBe(true);
    fixture.componentInstance.tabCommand('select', 'detached');
    await vi.waitFor(() => expect(bridge.taskBrowserDetach).toHaveBeenCalledWith('scope', 1, 'detached', context));
    await fixture.componentInstance.returnTab();
    expect(bridge.taskBrowserReturn).toHaveBeenCalledExactlyOnceWith('scope', 1, 'detached');
    expect(bridge.taskBrowserCommand).not.toHaveBeenCalled();
  });
  it('keeps a companion bound to one tab when the new-tab shortcut is pressed', async () => {
    const { fixture, bridge } = setup([tab('existing')]);
    fixture.componentRef.setInput('detachedWindow', true); fixture.componentRef.setInput('active', true); await render(fixture);
    expect(fixture.nativeElement.querySelector('ex-view-tabs')).toBeNull();
    fixture.nativeElement.querySelector('.browser').dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true }));
    await fixture.componentInstance.newTab();
    expect(bridge.taskBrowserCommand).not.toHaveBeenCalled();
  });
});

describe('Local tabs on a remote task', () => {
  it.each(['server', 'device'] as const)('shows local routing (%s) and keeps privacy details outside the pill', async routing => {
    const { fixture, bridge } = setup([{ ...tab(), execution: 'local', routing, agentAccess: 'unavailable', url: 'http://localhost:3000', ready: true, errors: 3 }]);
    await render(fixture);
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.local-only')?.textContent?.trim()).toBe(routing === 'server' ? 'Local · Proxied' : 'Local');
    expect(root.querySelector('[aria-label="Point and ask (⇧⌘C)"]')).toBeNull();
    expect(root.textContent).not.toContain('Send to agent');
    await fixture.componentInstance.beginElementPick();
    expect(bridge.taskBrowserCommand).not.toHaveBeenCalledWith('scope', 1, { kind: 'pick', enabled: true });
    fixture.componentInstance.showDialog('tools'); fixture.detectChanges();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(routing === 'server' ? 'Web traffic and localhost connections go through the task server' : 'Web traffic uses this device');
    expect(dialog?.textContent).not.toContain('Block agent'); expect(dialog?.textContent).not.toContain('Allow agent');
    expect(dialog?.querySelector('.feedback')).toBeNull();
  });

  it('offers local creation only when main advertises mixed tabs', async () => {
    const { fixture, bridge } = setup([tab()]); await render(fixture);
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[aria-label="New tab options"]')).toBeNull();
    fixture.componentInstance.store.state.update(state => state && { ...state, canCreateLocalTabs: true }); fixture.detectChanges();
    expect(root.querySelector('[aria-label="New tab options"]')).not.toBeNull();
    fixture.componentInstance.newTab('local');
    expect(bridge.taskBrowserCommand).toHaveBeenCalledWith('scope', 1, { kind: 'new-tab', location: 'local' });
  });
});
