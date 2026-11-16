import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import type { TaskBrowserState, TaskBrowserWindowInfo } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../src/app/backend/backend-client.service';
import { BrowserWindowComponent } from '../src/app/task-browser';
import { StartTabFixture } from './task-browser-demo.component';

class BrowserWindowFixture extends StartTabFixture {
  readonly platform = 'darwin';
  private stateListener?: (state: TaskBrowserState) => void;
  private infoListener?: (info: TaskBrowserWindowInfo) => void;
  private info: TaskBrowserWindowInfo = { scopeId: 'preview', taskId: 1, tabId: 'preview-1', available: true, context: { projectName: 'Elevenex', taskName: 'Polish checkout flow', branchName: 'feat/checkout', stage: 'active', hue: 'ocean', machineName: 'This Mac' } };
  constructor() {
    super();
    this.state = { ...this.state, active: 'preview-1', tabs: [{ id: 'preview-1', title: 'New tab', url: '', by: 'you', driver: 'you', agentSessionId: null, generation: 1, loading: false, ready: false, canGoBack: false, error: null, errors: 0, width: 'full', theme: 'system', slowNetwork: false, waiting: false }] };
  }
  async taskBrowserWindow() { return this.info; }
  async taskBrowserWindowAction() { /* Native window behavior is covered by the Electron smoke. */ }
  onTaskBrowserWindowChanged(listener: (info: TaskBrowserWindowInfo) => void) { this.infoListener = listener; return () => { this.infoListener = undefined; }; }
  override onTaskBrowserChanged(listener: (state: TaskBrowserState) => void) { this.stateListener = listener; return () => { this.stateListener = undefined; }; }
  setState(driver: 'you' | 'agent' | 'needs') {
    this.state = { ...this.state, revision: this.state.revision + 1, tabs: this.state.tabs.map(tab => ({ ...tab, driver, agentSessionId: driver === 'you' ? null : 2, waiting: false, step: driver === 'agent' ? { n: 2, total: 4, text: 'Checking the checkout flow' } : undefined })) };
    this.stateListener?.(this.state);
  }
  unavailable() { this.info = { ...this.info, available: false }; this.infoListener?.(this.info); }
  longNames() { this.info = { ...this.info, context: { ...this.info.context, projectName: 'International storefront', taskName: 'Improve checkout validation and payment recovery' } }; this.infoListener?.(this.info); }
}
@Component({
  selector: 'ex-browser-window-demo',
  imports: [BrowserWindowComponent],
  providers: [BrowserWindowFixture, { provide: ELEVENEX_BRIDGE, useExisting: BrowserWindowFixture }],
  template: '<ex-browser-window />',
  styles: ':host { display: block; height: 100%; }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowserWindowDemoComponent { readonly fixture = inject(BrowserWindowFixture); }
