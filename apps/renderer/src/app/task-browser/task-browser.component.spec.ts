import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskBrowserCommand, TaskBrowserState, TaskBrowserTab, TaskBrowserWindowContext, ElevenexBridge } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { TaskBrowserComponent } from './task-browser.component';

function tab(id = 'tab-1'): TaskBrowserTab {
  return { id, title: 'New tab', url: '', by: 'you', driver: 'you', agentSessionId: null, generation: 1, loading: false, ready: false, canGoBack: false, error: null, errors: 0, width: 'full', theme: 'system', slowNetwork: false, waiting: false };
}
function setup(tabs: readonly TaskBrowserTab[] = []) {
  let state: TaskBrowserState = { scopeId: 'scope', taskId: 1, revision: 0, surfaceEpoch: 0, controlsFocus: 0, active: tabs[0]?.id ?? null, tabs, picked: null, picking: false, pickerMessage: null, feedback: false, ports: [3000], privacy: 'content-withheld' };
  const bridge = {
    taskBrowserDetach: vi.fn<NonNullable<ElevenexBridge['taskBrowserDetach']>>(async () => undefined),
    taskBrowserReturn: vi.fn<NonNullable<ElevenexBridge['taskBrowserReturn']>>(async () => undefined),
    taskBrowserRead: vi.fn(async () => ({ ok: true, value: state })),
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
