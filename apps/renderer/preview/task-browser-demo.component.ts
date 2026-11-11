import { ChangeDetectionStrategy, Component } from '@angular/core';
import type { BackendResult, ElevenexBridge, TaskBrowserCommand, TaskBrowserState, TaskBrowserTab, TaskBrowserPlacement, TaskBrowserWindowContext, TaskBrowserLayout } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../src/app/backend/backend-client.service';
import { TaskBrowserComponent } from '../src/app/task-browser';

/** Preview-only transport for exercising the production start-tab owner. No network or guest. */
export class StartTabFixture implements Pick<ElevenexBridge, 'taskBrowserRead' | 'taskBrowserHide' | 'taskBrowserCommand' | 'taskBrowserLayout'> {
  lastLayout: TaskBrowserLayout | null = null;
  async taskBrowserLayout(_scope: string, _task: number, input: TaskBrowserLayout): Promise<void> { this.lastLayout = input; }
  protected state: TaskBrowserState = { canDetach: true, canReorder: true, placement: 'desktop', availablePlacements: ['desktop', 'desktop-proxy', 'machine'], capabilities: { embedded: true, audio: true, accessibility: true, filePicker: true, downloads: true }, scopeId: 'preview', taskId: 1, revision: 0, surfaceEpoch: 0, controlsFocus: 0, tabs: [], active: null, picked: null, picking: false, pickerMessage: null, feedback: false, ports: [3000, 4310], privacy: 'content-withheld' };
  private changed?: (state: TaskBrowserState) => void;
  onTaskBrowserChanged(listener: (state: TaskBrowserState) => void) { this.changed = listener; return () => { this.changed = undefined; }; }
  async taskBrowserDetach(_scope: string, _task: number, tabId: string) { this.present(tabId, true); }
  async taskBrowserReturn(_scope: string, _task: number, tabId: string) { this.present(tabId, false); }
  private present(tabId: string, detached: boolean): void {
    this.state = { ...this.state, revision: this.state.revision + 1, tabs: this.state.tabs.map(tab => tab.id === tabId ? { ...tab, detached } : tab) };
    this.changed?.(this.state);
  }
  private nextId = 0;
  /** Simulate agent acquisition without adding automation to the product bridge. */
  drive(tabId: string): void {
    this.state = { ...this.state, agentCode: 1, revision: this.state.revision + 1, tabs: this.state.tabs.map(tab => tab.id === tabId ? { ...tab, driver: 'agent', agentSessionId: 2, generation: tab.generation + 1, waiting: false } : tab) };
    this.changed?.(this.state);
  }
  async taskBrowserRead(): Promise<BackendResult<TaskBrowserState>> { return { ok: true, value: this.state }; }
  async taskBrowserConfigure(_scope: string, _task: number, placement: TaskBrowserPlacement): Promise<BackendResult<TaskBrowserState>> {
    if (this.state.tabs.some(tab => tab.url)) return { ok: false, error: { code: 'unavailable', message: 'Close loaded tabs first.' } };
    const native = placement !== 'machine';
    this.state = { ...this.state, placement, canRecover: native ? undefined : true, revision: 0, capabilities: { embedded: native, audio: native, accessibility: native, filePicker: native, downloads: native } };
    return { ok: true, value: this.state };
  }
  async taskBrowserHide() { /* No guest in this preview. */ }
  async taskBrowserCommand(_scope: string, _task: number, input: TaskBrowserCommand): Promise<BackendResult<TaskBrowserState>> {
    if (input.kind === 'new-tab') {
      if (this.state.tabs.length >= 12) return { ok: false, error: { code: 'unavailable', message: 'Close a tab before opening another.' } };
      const tab: TaskBrowserTab = { id: 'preview-' + ++this.nextId, title: 'New tab', url: '', by: 'you', driver: 'you', agentSessionId: null, generation: 1, loading: false, ready: false, canGoBack: false, canGoForward: false, error: null, errors: 0, width: 'full', theme: 'system', slowNetwork: false, waiting: false };
      this.state = { ...this.state, active: tab.id, tabs: [...this.state.tabs, tab] };
    } else if (input.kind === 'move-tab') {
      const tab = this.state.tabs.find(tab => tab.id === input.tabId);
      if (tab && input.tabId !== input.beforeTabId) {
        const tabs = this.state.tabs.filter(tab => tab.id !== input.tabId);
        tabs.splice(input.beforeTabId === null ? tabs.length : tabs.findIndex(tab => tab.id === input.beforeTabId), 0, tab);
        this.state = { ...this.state, tabs };
      }
    } else if (input.kind === 'select') this.state = { ...this.state, active: input.tabId };
    else if (input.kind === 'pick') this.state = { ...this.state, picking: input.enabled, picked: null, capturePending: false };
    else if (input.kind === 'close') {
      const tabs = this.state.tabs.filter(tab => tab.id !== input.tabId);
      this.state = { ...this.state, tabs, active: this.state.active === input.tabId ? tabs.at(-1)?.id ?? null : this.state.active };
    } else if (input.kind === 'takeover' || input.kind === 'handoff') {
      this.state = { ...this.state, tabs: this.state.tabs.map(tab => tab.id === input.tabId ? { ...tab, driver: input.kind === 'takeover' ? 'you' : 'agent', waiting: input.kind === 'takeover', generation: tab.generation + 1 } : tab) };
    } else if (input.kind === 'navigate') {
      this.state = { ...this.state, tabs: this.state.tabs.map(tab => tab.id === input.tabId ? { ...tab, url: input.url, title: new URL(input.url).host, error: 'Website loading is unavailable in this component preview.' } : tab) };
    }
    this.state = { ...this.state, revision: this.state.revision + 1 };
    return { ok: true, value: this.state };
  }
}
@Component({
  selector: 'ex-task-browser-demo',
  imports: [TaskBrowserComponent],
  providers: [{ provide: ELEVENEX_BRIDGE, useFactory: () => new StartTabFixture() }],
  template: '<ex-task-browser scopeId="preview" [taskId]="1" [active]="true" [windowContext]="context" />',
  styles: ':host { display: block; height: 100%; min-height: 0; padding: var(--space-4); }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskBrowserDemoComponent {
  readonly context: TaskBrowserWindowContext = { projectName: 'Elevenex', taskName: 'Browser tabs', branchName: 'feat/browser', machineName: 'This Mac', stage: 'active', hue: 'ocean' };
}

/** Isolated mixed-tab data; production owns the two engines and SSH routing. */
class RemoteTabsFixture extends StartTabFixture {
  constructor() {
    super();
    this.state = { ...this.state, placement: 'machine', canCreateLocalTabs: true, agentCode: 1, capabilities: { embedded: false, audio: false, accessibility: false, filePicker: true, downloads: true } };
  }
  override async taskBrowserCommand(scope: string, task: number, input: TaskBrowserCommand): Promise<BackendResult<TaskBrowserState>> {
    const current = this.state.tabs.find(tab => tab.id === this.state.active);
    if (current?.agentAccess === 'unavailable' && (input.kind === 'handoff' || (input.kind === 'pick' && input.enabled))) return { ok: false, error: { code: 'unavailable', message: 'Agents cannot inspect local tabs.' } };
    const reply = await super.taskBrowserCommand(scope, task, input);
    if (!reply.ok) return reply;
    if (input.kind === 'new-tab') this.state = { ...this.state, tabs: this.state.tabs.map(tab => tab.id === this.state.active ? { ...tab, execution: input.location === 'local' ? 'local' : 'remote', ...(input.location === 'local' ? { agentAccess: 'unavailable' as const, routing: 'server' as const } : {}) } : tab) };
    const local = this.state.tabs.find(tab => tab.id === this.state.active)?.execution === 'local';
    this.state = { ...this.state, capabilities: { embedded: local, audio: local, accessibility: local, filePicker: true, downloads: true } };
    return { ok: true, value: this.state };
  }
}
@Component({
  selector: 'ex-remote-tabs-demo',
  imports: [TaskBrowserComponent],
  providers: [{ provide: ELEVENEX_BRIDGE, useFactory: () => new RemoteTabsFixture() }],
  template: '<ex-task-browser scopeId="preview" [taskId]="1" [active]="true" [windowContext]="context" />',
  styles: ':host { display: block; height: 100%; min-height: 0; padding: var(--space-4); }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemoteTabsDemoComponent {
  readonly context: TaskBrowserWindowContext = { projectName: 'Elevenex', taskName: 'Remote browser', branchName: 'feat/browser', machineName: 'Development server', stage: 'active', hue: 'ocean' };
}
