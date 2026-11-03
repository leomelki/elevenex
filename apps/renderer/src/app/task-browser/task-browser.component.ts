import { OverlayContainer } from '@angular/cdk/overlay';
import { ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import type { TaskBrowserCommand } from '@elevenex/shared';
import { BrowserViewComponent, type BrowserQuestion, type BrowserTab, type BrowserTarget } from '../views';
import { ButtonComponent, FoldComponent, IconComponent, ModalLayerComponent } from '../ui';
import { TaskBrowserStore } from './task-browser.store';
import { NativePageLayout } from './native-page-layout';
export interface BrowserComposerIntent { readonly scopeId: string; readonly taskId: number; readonly sessionId: number; readonly text: string }
@Component({
  selector: 'ex-task-browser',
  imports: [BrowserViewComponent, ButtonComponent, FoldComponent, IconComponent, ModalLayerComponent],
  providers: [TaskBrowserStore],
  templateUrl: './task-browser.component.html', styleUrl: './task-browser.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskBrowserComponent {
  readonly scopeId = input<string | null>(null);
  readonly taskId = input<number | null>(null);
  readonly sessionId = input<number | null>(null);
  readonly active = input(false);
  readonly contextRequested = output<BrowserComposerIntent>();
  readonly store = inject(TaskBrowserStore);
  readonly dialog = signal<'new' | 'tools' | null>(null);
  readonly dialogOpen = signal(false);
  readonly address = signal('http://localhost:3000');
  readonly notice = signal('');
  readonly current = this.store.current;
  readonly tabs = computed<readonly BrowserTab[]>(() => (this.store.state()?.tabs ?? []).map(tab => ({ id: tab.id, title: tab.title, url: tab.url, by: tab.by, server: tab.server, status: tab.error ? 'failed' : tab.loading ? 'running' : 'idle' })));
  readonly picked = computed<BrowserTarget | undefined>(() => {
    const element = this.store.state()?.picked;
    return element ? { x: element.x, y: element.y, w: element.width, h: element.height, label: element.selector } : undefined;
  });
  readonly target = computed<BrowserTarget | undefined>(() => {
    const element = this.current()?.target;
    return element ? { x: element.x, y: element.y, w: element.width, h: element.height, label: element.tag } : undefined;
  });
  private readonly overlays = inject(OverlayContainer);
  private readonly surface = viewChild<ElementRef<HTMLElement>>('surface');
  private readonly browser = viewChild(BrowserViewComponent);
  private controlsIdentity = '';
  private controlsSeen = 0;
  private pickerSession: number | null = null;
  private pickerIdentity = '';
  constructor() {
    effect(() => this.store.open(this.scopeId(), this.taskId()));
    effect(() => { if (!this.active()) { this.dialogOpen.set(false); this.hideSurface(); } });
    effect(() => {
      const state = this.store.state(), picked = state?.picked;
      const identity = picked ? state.scopeId + ':' + state.taskId + ':' + JSON.stringify(picked) : '';
      if (identity !== this.pickerIdentity) { this.pickerIdentity = identity; this.pickerSession = picked ? untracked(this.sessionId) : null; }
    });
    afterRenderEffect(() => {
      const state = this.store.state(); if (!state) return;
      const identity = state.scopeId + ':' + state.taskId;
      if (identity !== this.controlsIdentity) { this.controlsIdentity = identity; this.controlsSeen = state.controlsFocus; return; }
      if (state.controlsFocus !== this.controlsSeen) { this.controlsSeen = state.controlsFocus; if (this.active()) this.browser()?.focusControls(); }
    });
    afterRenderEffect(onCleanup => {
      const scope = this.scopeId(), task = this.taskId();
      if (!scope || !task || !this.active() || !this.store.bridge.taskBrowserLayout) return;
      const layout = new NativePageLayout(() => this.surface()?.nativeElement,
        () => this.active() && !this.dialogOpen() && !this.current()?.error && !this.current()?.loading && !this.store.state()?.picked && !!this.current()?.url,
        input => this.store.bridge.taskBrowserLayout(scope, task, { ...input, ownerGeneration: this.current()?.generation ?? 0, surfaceEpoch: this.store.state()?.surfaceEpoch ?? 0 }),
        () => this.store.bridge.taskBrowserHide(scope, task), () => this.store.state()?.surfaceEpoch ?? 0, this.overlays.getContainerElement(), () => this.current()?.generation ?? 0);
      onCleanup(() => layout.destroy());
    });
  }
  private hideSurface(): void { const scope = this.scopeId(), task = this.taskId(); if (scope && task) void this.store.bridge.taskBrowserHide?.(scope, task); }
  dismissNotice(): void { this.notice.set(''); this.store.error.set(''); if (this.store.state()?.pickerMessage) this.command({ kind: 'pick', enabled: false }); }
  command(input: TaskBrowserCommand): void { void this.store.command(input); }
  tabCommand(kind: 'select' | 'close' | 'back' | 'reload' | 'takeover' | 'handoff' | 'outside' | 'focus', tabId = this.current()?.id): void {
    if (tabId) {
      if (kind === 'handoff') { const sessionId = this.current()?.agentSessionId ?? this.sessionId(); if (sessionId) this.command({ kind, tabId, sessionId }); else this.notice.set('Choose a conversation before handing control to the agent.'); }
      else this.command({ kind, tabId });
    }
  }
  handToSelected(): void {
    const sessionId = this.sessionId(), tabId = this.current()?.id;
    if (sessionId && tabId) this.command({ kind: 'handoff', tabId, sessionId });
    this.dialogOpen.set(false);
  }
  showDialog(kind: 'new' | 'tools'): void {
    this.hideSurface(); this.dialog.set(kind); this.dialogOpen.set(true);
  }
  navigate(value: string): void {
    const tabId = this.current()?.id;
    if (tabId) this.command({ kind: 'navigate', tabId, url: this.normalize(value) });
  }
  async openPage(): Promise<void> { if (this.store.pending()) return; if (await this.store.command({ kind: 'open', url: this.normalize(this.address()) })) this.dialogOpen.set(false); }
  private normalize(value: string): string { const trimmed = value.trim(); if (/^[0-9]{1,5}$/.test(trimmed)) return 'http://localhost:' + trimmed; return /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : 'http://' + trimmed; }
  setWidth(width: 'full' | 'phone'): void { const tabId = this.current()?.id; if (tabId) this.command({ kind: 'width', tabId, width }); }
  theme(theme: 'light' | 'dark' | 'system'): void { const tabId = this.current()?.id; if (tabId) this.command({ kind: 'theme', tabId, theme }); }
  network(slow: boolean): void { const tabId = this.current()?.id; if (tabId) this.command({ kind: 'network', tabId, slow }); }
  ask(question: BrowserQuestion): void {
    if (this.pickerSession !== this.sessionId()) { this.notice.set('The conversation changed. Pick the element again for this session.'); return; }
    this.compose(`${question.text}\n\nBrowser element: ${question.target.label}\nViewport rectangle: ${question.target.x}, ${question.target.y}, ${question.target.w} × ${question.target.h} CSS pixels.\nScreenshot and source location unavailable.`);
    this.command({ kind: 'pick', enabled: false });
  }
  sendErrors(): void { this.compose(`The task browser reported ${this.current()?.errors ?? 0} console or request errors. Raw messages, URLs and request content are withheld for privacy. Please help investigate the task server.`); }
  private compose(text: string): void {
    const scopeId = this.scopeId(), taskId = this.taskId(), sessionId = this.sessionId();
    if (!scopeId || !taskId || !sessionId) { this.notice.set('Choose a conversation to add browser context.'); return; }
    this.contextRequested.emit({ scopeId, taskId, sessionId, text });
    this.notice.set('Added to the selected conversation’s composer. Review it, then send.');
  }
}
