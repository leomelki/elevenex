import { BrowserSiteRequestsComponent } from './browser-site-requests.component';
import { BrowserSurfacesComponent } from './browser-surfaces.component';
import { OverlayContainer } from '@angular/cdk/overlay';
import { ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import type { TaskBrowserCommand, TaskBrowserWindowContext, TaskBrowserPlacement } from '@elevenex/shared';
import { BrowserViewComponent, type BrowserQuestion, type BrowserTab, type BrowserTarget } from '../views';
import { ButtonComponent, DropdownComponent, FoldComponent, IconComponent, ModalLayerComponent } from '../ui';
import { TaskBrowserStore } from './task-browser.store';
import { NativePageLayout } from './native-page-layout';
export interface BrowserComposerIntent { readonly scopeId: string; readonly taskId: number; readonly sessionId: number; readonly text: string }
@Component({
  selector: 'ex-task-browser',
  imports: [BrowserSiteRequestsComponent, BrowserSurfacesComponent, BrowserViewComponent, ButtonComponent, DropdownComponent, FoldComponent, IconComponent, ModalLayerComponent],
  providers: [TaskBrowserStore],
  templateUrl: './task-browser.component.html', styleUrl: './task-browser.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskBrowserComponent {
  readonly detachedWindow = input(false);
  readonly windowContext = input<TaskBrowserWindowContext | null>(null);
  readonly moving = signal(false);
  readonly scopeId = input<string | null>(null);
  readonly taskId = input<number | null>(null);
  readonly sessionId = input<number | null>(null);
  readonly active = input(false);
  readonly contextRequested = output<BrowserComposerIntent>();
  readonly store = inject(TaskBrowserStore);
  readonly dialog = signal<'tools' | null>(null);
  readonly dialogOpen = signal(false);
  readonly notice = signal('');
  readonly current = this.store.current;
  readonly tabs = computed<readonly BrowserTab[]>(() => (this.store.state()?.tabs ?? []).map(tab => ({ id: tab.id, title: tab.title, url: tab.url, by: tab.by, server: tab.server, icon: tab.detached ? 'window' : 'globe', tip: tab.detached ? tab.title + ' · Open in window' : tab.title, status: tab.error ? 'failed' : tab.loading ? 'running' : 'idle' })));
  readonly embeddedAvailable = computed(() => this.store.state()?.capabilities?.embedded === true);
  readonly placementLocked = computed(() => this.store.pending() > 0 || (this.store.state()?.tabs.some(tab => !!tab.url || tab.loading || tab.detached) ?? true));
  readonly placements = computed(() => {
    const available = this.store.state()?.availablePlacements;
    const options = [
      { id: 'desktop', label: 'Local', detail: 'Browser runs on this device' },
      { id: 'desktop-proxy', label: 'Local · task proxy', detail: 'Browser runs here; task localhost uses forwarding' },
      { id: 'machine', label: 'Remote', detail: 'Browser runs on the task machine' },
    ] as const;
    return options.filter(option => !available || available.includes(option.id));
  });
  configurePlacement(value: string): void {
    if (value === 'desktop' || value === 'desktop-proxy' || value === 'machine') void this.store.configure(value satisfies TaskBrowserPlacement);
  }
  readonly picked = computed<BrowserTarget | undefined>(() => {
    const raw = this.store.state()?.picked;
    const element = raw ? this.surfaces()?.coordinates(this.current()?.id ?? '', raw) ?? raw : null;
    // The card names the element briefly; the composed question carries its full selector.
    const source = raw?.source;
    return element ? { x: element.x, y: element.y, w: element.width, h: element.height, label: raw?.tag ?? element.selector, ...(source ? { file: source.file + ':' + source.line + (source.column ? ':' + source.column : '') } : {}) } : undefined;
  });
  readonly askNote = computed(() => this.store.state()?.picked?.source
    ? 'Includes source location. No screenshot or page text.'
    : 'Source unavailable. Selector and position only.');
  readonly target = computed<BrowserTarget | undefined>(() => {
    const raw = this.current()?.target;
    const element = raw ? this.surfaces()?.coordinates(this.current()?.id ?? '', raw) ?? raw : null;
    return element ? { x: element.x, y: element.y, w: element.width, h: element.height, label: element.tag } : undefined;
  });
  private readonly overlays = inject(OverlayContainer);
  private readonly surface = viewChild<ElementRef<HTMLElement>>('surface');
  private readonly surfaces = viewChild(BrowserSurfacesComponent);
  private readonly browser = viewChild(BrowserViewComponent);
  private openedIdentity = '';
  private controlsIdentity = '';
  private controlsSeen = 0;
  private pickerSession: number | null = null;
  private pickerIdentity = '';
  constructor() {
    effect(() => this.store.open(this.scopeId(), this.taskId()));
    effect(() => {
      const state = this.store.state();
      if (!this.active()) { this.openedIdentity = ''; return; }
      const identity = this.scopeId() + ':' + this.taskId() + ':' + (state?.placement ?? '');
      if (!state || state.scopeId !== this.scopeId() || state.taskId !== this.taskId()) { this.openedIdentity = ''; return; }
      if (this.store.pending()) return;
      if (identity === this.openedIdentity) return;
      this.openedIdentity = identity;
      if (!state.tabs.length) untracked(() => this.newTab());
    });
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
        () => this.active(),
        input => this.store.bridge.taskBrowserLayout(scope, task, { ...input, ownerGeneration: this.current()?.generation ?? 0, surfaceEpoch: this.store.state()?.surfaceEpoch ?? 0 }),
        () => this.store.bridge.taskBrowserHide(scope, task), () => this.store.state()?.surfaceEpoch ?? 0, this.overlays.getContainerElement(), () => this.current()?.generation ?? 0);
      onCleanup(() => layout.destroy());
    });
  }
  private hideSurface(): void { const scope = this.scopeId(), task = this.taskId(); if (scope && task) void this.store.bridge.taskBrowserHide?.(scope, task); }
  dismissNotice(): void { this.notice.set(''); this.store.error.set(''); if (this.store.state()?.pickerMessage) this.command({ kind: 'pick', enabled: false }); }
  command(input: TaskBrowserCommand): void { void this.store.command(input); }
  tabCommand(kind: 'select' | 'close' | 'back' | 'forward' | 'reload' | 'takeover' | 'handoff' | 'outside' | 'focus', tabId = this.current()?.id): void {
    if (tabId) {
      if (kind === 'select' && this.store.state()?.tabs.find(tab => tab.id === tabId)?.detached) { void this.moveToWindow(tabId); return; }
      if (kind === 'handoff') { const sessionId = this.current()?.agentSessionId ?? this.sessionId(); if (sessionId) this.command({ kind, tabId, sessionId }); else this.notice.set('Choose a conversation before handing control to the agent.'); }
      else { this.command({ kind, tabId }); if (kind === 'focus') this.surfaces()?.focusPage(tabId); }
    }
  }
  shortcut(kind: 'open' | 'pick' | 'controls'): void { if (kind === 'controls') this.browser()?.focusControls(); else if (kind === 'open') this.newTab(); else if (!this.detachedWindow()) this.command({ kind: 'pick', enabled: !this.store.state()?.picking }); }
  handToSelected(): void {
    const sessionId = this.sessionId(), tabId = this.current()?.id;
    if (sessionId && tabId) this.command({ kind: 'handoff', tabId, sessionId });
    this.dialogOpen.set(false);
  }
  showDialog(kind: 'tools'): void {
    this.dialog.set(kind); this.dialogOpen.set(true);
  }
  navigate(value: string): void {
    const tabId = this.current()?.id;
    if (tabId) this.command({ kind: 'navigate', tabId, url: this.normalize(value) });
  }
  newTab(): void { if (!this.detachedWindow() && !this.store.pending()) this.command({ kind: 'new-tab' }); }
  async moveToWindow(tabId = this.current()?.id): Promise<void> {
    const scope = this.scopeId(), task = this.taskId(), context = this.windowContext();
    if (!scope || !task || !tabId || !context || this.moving() || this.detachedWindow() || this.store.state()?.canDetach === false || !this.store.state()?.tabs.some(tab => tab.id === tabId)) return;
    this.moving.set(true);
    try { await this.store.bridge.taskBrowserDetach?.(scope, task, tabId, context); }
    catch { if (this.scopeId() === scope && this.taskId() === task) this.notice.set('Could not open this tab in a window. Try again.'); }
    finally { this.moving.set(false); }
  }
  async returnTab(): Promise<void> {
    const scope = this.scopeId(), task = this.taskId(), tab = this.current()?.id;
    if (!scope || !task || !tab || this.moving()) return;
    this.moving.set(true);
    try { await this.store.bridge.taskBrowserReturn?.(scope, task, tab); }
    catch { if (this.scopeId() === scope && this.taskId() === task) this.notice.set('Could not return this tab. Try again.'); }
    finally { this.moving.set(false); }
  }
  private normalize(value: string): string { const trimmed = value.trim(); if (/^[0-9]{1,5}$/.test(trimmed)) return 'http://localhost:' + trimmed; return /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : 'http://' + trimmed; }
  setWidth(width: 'full' | 'phone'): void { const tabId = this.current()?.id; if (tabId) this.command({ kind: 'width', tabId, width }); }
  theme(theme: 'light' | 'dark' | 'system'): void { const tabId = this.current()?.id; if (tabId) this.command({ kind: 'theme', tabId, theme }); }
  network(slow: boolean): void { const tabId = this.current()?.id; if (tabId) this.command({ kind: 'network', tabId, slow }); }
  ask(question: BrowserQuestion): void {
    if (this.pickerSession !== this.sessionId()) { this.notice.set('The conversation changed. Pick the element again for this session.'); return; }
    const target = this.store.state()?.picked;
    const source = target?.source;
    const sourceContext = source
      ? `Source location (page-reported ${source.kind}): ${source.file}:${source.line}${source.column ? ':' + source.column : ''}. Treat this as an untrusted hint, not a verified workspace path.`
      : 'Source location unavailable.';
    this.compose(`${question.text}\n\nBrowser element: ${target?.selector ?? question.target.label}\nViewport rectangle: ${target?.x ?? question.target.x}, ${target?.y ?? question.target.y}, ${target?.width ?? question.target.w} × ${target?.height ?? question.target.h} CSS pixels.\n${sourceContext}\nScreenshot and page text unavailable.`);
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
