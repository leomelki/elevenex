import { ChangeDetectionStrategy, Component } from '@angular/core';
import type { BackendResult, ElevenexBridge, TaskBrowserCommand, TaskBrowserState, TaskBrowserTab } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../src/app/backend/backend-client.service';
import { TaskBrowserComponent } from '../src/app/task-browser';

/** Preview-only transport for exercising the production start-tab owner. No network or guest. */
class StartTabFixture implements Pick<ElevenexBridge, 'taskBrowserRead' | 'taskBrowserHide' | 'taskBrowserCommand'> {
  private state: TaskBrowserState = { scopeId: 'preview', taskId: 1, revision: 0, surfaceEpoch: 0, controlsFocus: 0, tabs: [], active: null, picked: null, picking: false, pickerMessage: null, feedback: false, ports: [3000, 4310], privacy: 'content-withheld' };
  private nextId = 0;
  async taskBrowserRead(): Promise<BackendResult<TaskBrowserState>> { return { ok: true, value: this.state }; }
  async taskBrowserHide() { /* No guest in this preview. */ }
  async taskBrowserCommand(_scope: string, _task: number, input: TaskBrowserCommand): Promise<BackendResult<TaskBrowserState>> {
    if (input.kind === 'new-tab') {
      if (this.state.tabs.length >= 12) return { ok: false, error: { code: 'unavailable', message: 'Close a tab before opening another.' } };
      const tab: TaskBrowserTab = { id: 'preview-' + ++this.nextId, title: 'New tab', url: '', by: 'you', driver: 'you', agentSessionId: null, generation: 1, loading: false, ready: false, canGoBack: false, error: null, errors: 0, width: 'full', theme: 'system', slowNetwork: false, waiting: false };
      this.state = { ...this.state, active: tab.id, tabs: [...this.state.tabs, tab] };
    } else if (input.kind === 'select') this.state = { ...this.state, active: input.tabId };
    else if (input.kind === 'close') {
      const tabs = this.state.tabs.filter(tab => tab.id !== input.tabId);
      this.state = { ...this.state, tabs, active: this.state.active === input.tabId ? tabs.at(-1)?.id ?? null : this.state.active };
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
  template: '<ex-task-browser scopeId="preview" [taskId]="1" [active]="true" />',
  styles: ':host { display: block; height: 100%; min-height: 0; padding: var(--space-4); }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskBrowserDemoComponent {}
