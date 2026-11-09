import { BrowserAgentRequestsComponent } from './browser-agent-requests.component';
import { BrowserSiteRequestsComponent } from './browser-site-requests.component';
import { BrowserSurfacesComponent } from './browser-surfaces.component';
import { OverlayContainer } from '@angular/cdk/overlay';
import { ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import type { TaskBrowserCommand, TaskBrowserWindowContext, TaskBrowserPlacement, BrowserElementSnapshot, BrowserHumanRequest } from '@elevenex/shared';
import { BrowserViewComponent, type BrowserQuestion, type BrowserTab, type BrowserTarget } from '../views';
import { ButtonComponent, DropdownComponent, FoldComponent, IconComponent, ModalLayerComponent } from '../ui';
import { TaskBrowserStore } from './task-browser.store';
import { NativePageLayout } from './native-page-layout';
export interface BrowserComposerIntent { readonly scopeId: string; readonly taskId: number; readonly sessionId: number; readonly text: string; readonly element?: BrowserElementSnapshot }
@Component({
  selector: 'ex-task-browser',
  imports: [BrowserAgentRequestsComponent, BrowserSiteRequestsComponent, BrowserSurfacesComponent, BrowserViewComponent, ButtonComponent, DropdownComponent, FoldComponent, IconComponent, ModalLayerComponent],
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
  readonly attentionRequested = output<void>();
  readonly selectionPaused = computed(() => this.store.state()?.agentRequests?.some(request => request.tabId === this.current()?.id && !!request.selection) ?? false);
  private seenRequests = new Set<string>();
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
    // Detailed locators stay in the structured reference, outside the writing area.
    const source = raw?.source ?? raw?.componentSource;
    const file = source ? source.file + (source.line ? ':' + source.line : '') + (source.column ? ':' + source.column : '') : undefined;
    return element ? { x: element.x, y: element.y, w: element.width, h: element.height, label: raw?.snapshot?.reference.label ?? raw?.tag ?? element.selector, ...(file ? { file } : {}) } : undefined;
  });
  readonly askNote = computed(() => {
    const snapshot = this.store.state()?.picked?.snapshot;
    return snapshot?.jpeg ? 'Includes a snapshot with surrounding context. Review before sending.' : snapshot?.error || 'Image capture unavailable. Update the engine or attach a screenshot.';
  });
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
  private pickerOrigin = '';
  constructor() {
    let previousSession: number | null | undefined;
    effect(() => {
      const session = this.sessionId(), previous = previousSession;
      previousSession = session;
      if (previous === undefined || previous === session) return;
      const state = untracked(this.store.state);
      const requested = state?.agentRequests?.some(request => request.tabId === state.active && request.kind === 'element');
      if (!requested && (state?.picking || state?.picked || state?.capturePending)) {
        untracked(() => this.command({ kind: 'pick', enabled: false }));
        this.notice.set('The conversation changed. Pick the element again for this session.');
      }
    });
    effect(() => {
      const requests = this.store.state()?.agentRequests ?? [], ids = new Set(requests.map(request => request.id));
      const fresh = requests.some(request => !this.seenRequests.has(request.id)); this.seenRequests = ids;
      if (fresh) this.attentionRequested.emit();
    });
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
      const identity = picked ? state.scopeId + ':' + state.taskId + ':' + (picked.snapshot?.reference.id ?? JSON.stringify(picked)) : '';
      if (identity !== this.pickerIdentity) { this.pickerIdentity = identity; if (!this.pickerOrigin) this.pickerSession = picked ? untracked(this.sessionId) : null; }
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
  async beginElementPick(tabId: string): Promise<void> {
    const tab = this.store.state()?.tabs.find(tab => tab.id === tabId);
    if (!tab || tab.detached) { this.notice.set('The original tab is closed or in another window. Choose a page and pick a new element.'); return; }
    const scope = this.scopeId(), task = this.taskId(), session = this.sessionId();
    const selected = await this.store.command({ kind: 'select', tabId });
    if (!selected || this.current()?.id !== tabId) return;
    if (this.scopeId() === scope && this.taskId() === task && this.sessionId() === session) this.command({ kind: 'pick', enabled: true });
  }
  private hideSurface(): void { const scope = this.scopeId(), task = this.taskId(); if (scope && task) void this.store.bridge.taskBrowserHide?.(scope, task); }
  dismissNotice(): void { this.notice.set(''); this.store.error.set(''); if (this.store.state()?.pickerMessage) this.command({ kind: 'pick', enabled: false }); }
  command(input: TaskBrowserCommand): void {
    if (input.kind === 'pick') {
      this.pickerOrigin = input.enabled ? this.scopeId() + ':' + this.taskId() : '';
      this.pickerSession = input.enabled ? this.sessionId() : null;
    }
    const command = this.store.state()?.elementSnapshots === 1 && (input.kind === 'pick' || input.kind === 'agent-request-pick') ? { ...input, visual: 1 as const } : input;
    void this.store.command(command);
  }
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
    if (this.pickerSession !== this.sessionId() || (this.pickerOrigin && this.pickerOrigin !== this.scopeId() + ':' + this.taskId())) { this.notice.set('The conversation changed. Pick the element again for this session.'); return; }
    const target = this.store.state()?.picked;
    if (question.tabId !== this.current()?.id || (target?.snapshot && target.snapshot.reference.tabId !== question.tabId)) { this.notice.set('The selected tab changed. Pick the element again.'); return; }
    const scopeId = this.scopeId(), taskId = this.taskId(), sessionId = this.sessionId();
    if (!scopeId || !taskId || !sessionId) return;
    if (!target?.snapshot?.jpeg) { this.notice.set(target?.snapshot?.error || 'This browser cannot capture element images. Update the engine or attach a screenshot.'); return; }
    this.notice.set('Adding the element to your message…');
    this.contextRequested.emit({ scopeId, taskId, sessionId, text: question.text, element: target.snapshot });
  }
  contextStaged(intent: BrowserComposerIntent, staged: boolean): void {
    if (intent.scopeId !== this.scopeId() || intent.taskId !== this.taskId() || intent.sessionId !== this.sessionId()) return;
    this.notice.set(staged ? 'Added to your message. Review the snapshot, then send.' : 'Could not add this context. Check the conversation for details, then try again.');
    if (staged && intent.element && this.store.state()?.picked?.snapshot?.reference.id === intent.element.reference.id) this.command({ kind: 'pick', enabled: false });
  }
  shareRequest(request: BrowserHumanRequest): void {
    const scopeId = this.scopeId(), taskId = this.taskId(), sessionId = this.sessionId();
    if (!scopeId || !taskId || sessionId !== request.sessionId || !request.selection?.snapshot?.jpeg) { this.notice.set('Open the requesting conversation to add this snapshot.'); return; }
    this.contextRequested.emit({ scopeId, taskId, sessionId, text: '', element: request.selection.snapshot });
  }
  sendErrors(): void { this.compose(`The task browser reported ${this.current()?.errors ?? 0} console or request errors. Raw messages, URLs and request content are withheld for privacy. Please help investigate the task server.`); }
  private compose(text: string): void {
    const scopeId = this.scopeId(), taskId = this.taskId(), sessionId = this.sessionId();
    if (!scopeId || !taskId || !sessionId) { this.notice.set('Choose a conversation to add browser context.'); return; }
    this.contextRequested.emit({ scopeId, taskId, sessionId, text });
    this.notice.set('Added to the selected conversation’s composer. Review it, then send.');
  }
}
