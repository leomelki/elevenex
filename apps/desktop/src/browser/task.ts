import { agentProfile } from './agent-profile';
import type { DesktopBrowserHost } from './host';
import { BrowserAgentEngine, BrowserInteractionController, RelatedBrowserTabs, delay } from '@elevenex/browser-agent';
import type { BrowserCodeCommand, BrowserCodeResult } from '@elevenex/shared';
import { BrowserTaskSession, type BrowserTaskProfiles } from './task-session';
import { TaskBrowserNetwork, type BrowserServerProxy } from './network';
import type { BrowserAgentCommand, BrowserAgentState, BrowserElement, TaskBrowserCommand, TaskBrowserLayout, TaskBrowserState, TaskBrowserSurface, TaskBrowserStreamInput, TaskBrowserFrame } from '@elevenex/shared';
import { shell, type BrowserWindow } from 'electron';
import { requestBackendJson } from '../backend-client/transport';
import { record } from './validation';
import type { BackendClient } from '../backend-client/client';
import type { RemoteManager } from '../remote/manager';
import { BrowserPage } from './surface';
import { browserUrl, intersect, loopback } from './validation';
import type { BrowserPersistence, SavedBrowser } from './persistence';

/** Task workspace lifetime, independent of the selected conversation and panel. */
export class TaskBrowser implements DesktopBrowserHost {
  private readonly relatedTabs = new RelatedBrowserTabs();
  private controlUpdating = false;
  private synchronizeControls(): void {
    if (this.controlUpdating || this.disposed) return;
    this.controlUpdating = true;
    try {
      for (const page of this.pages.values())
        if (
          page.lease.driver !== 'agent' &&
          !(page.independent && page.requested && page.contents.isDestroyed())
        )
          for (const id of this.relatedTabs.members(page.id)) {
            const sibling = this.pages.get(id);
            if (sibling?.lease.driver === 'agent') sibling.lease.takeOver(page.lease.driver === 'needs', page.lease.agentPaused);
          }
    } finally {
      this.controlUpdating = false;
    }
    this.emit();
  }
  private handBackGroup(page: BrowserPage, sessionId: number): void {
    this.controlUpdating = true;
    try {
      for (const id of this.relatedTabs.members(page.id))
        this.pages.get(id)?.lease.handBack(sessionId);
    } finally {
      this.controlUpdating = false;
    }
    this.emit();
  }
  private acquirePage(sessionId: number, tabId: string): void {
    this.assertScope();
    const page = this.page(tabId);
    const members = this.relatedTabs.members(tabId).map(id => this.page(id));
    if (members.some(item => item.lease.agentPaused))
      throw new Error('Browser agent is stopped. The user explicitly blocked access; ask them to choose Allow agent.');
    if (members.some(item => item.lease.driver !== 'you' && item.lease.agentSessionId !== null && item.lease.agentSessionId !== sessionId))
      throw new Error('This tab is controlled by another conversation.');
    this.interactions.reclaim(members.map(item => item.id));
    if (members.some(item => item.lease.driver !== 'agent')) this.handBackGroup(page, sessionId);
  }
  private readonly codeEngine = new BrowserAgentEngine({
    playwright: true,
    profile: { cookies: () => agentProfile(this.profile.session).cookies(), addCookies: cookies => agentProfile(this.profile.session).addCookies(cookies), clearCookies: () => agentProfile(this.profile.session).clearCookies() },
    watch: listener => { this.observers.add(listener); return () => this.observers.delete(listener); },
    interact: (sessionId, command) => this.interactions.execute(sessionId, command),
    document: tabId => this.pages.get(tabId)?.documentId,
    proxy: async () => { await this.profile.configure(); return this.network.proxyAddress(); },
    authorizeUrl: async (url, signal) => { signal.throwIfAborted(); await this.network.outside(browserUrl(url)); signal.throwIfAborted(); },
    version: () => Promise.resolve(process.versions.chrome ?? '140.0.0.0'),
    newPage: (sessionId, signal) => this.openCodePage(sessionId, signal),
    acquire: async (sessionId, tabId, signal) => { signal.throwIfAborted(); this.acquirePage(sessionId, tabId); },
    list: sessionId => {
      this.assertScope();
      return [...this.pages.values()].map(page => ({ id: page.id, generation: page.lease.generation, populated: !!page.url || page.hasContents, owned: page.lease.driver === 'agent' && page.lease.agentSessionId === sessionId,
        ...(page.lease.driver === 'agent' && page.lease.agentSessionId === sessionId ? { url: page.url } : {}) }));
    },
    open: async (sessionId, url, signal) => { browserUrl(url); return this.openCodePage(sessionId, signal); },
    get: async (sessionId, id) => this.codeTarget(this.page(id), sessionId, AbortSignal.timeout(1000)),
  });
  private readonly interactions = new BrowserInteractionController({
    changed: () => this.emit(), version: process.versions.chrome,
    authorize: async sessionId => {
      const result = await this.client.execute(this.window.webContents.id, this.scopeId, null, false, async (endpoint, signal) => {
        const value = record(await requestBackendJson(endpoint, { path: '/api/desktop-browser/authorize', method: 'POST', body: { taskId: this.taskId, sessionId } }, signal));
        if (value['available'] !== true || value['taskId'] !== this.taskId || value['sessionId'] !== sessionId) throw new Error('Conversation is unavailable');
      });
      this.assertScope(); if (!result.ok) throw new Error('Cannot return browser control to this conversation');
    },
    tab: id => {
      const page = this.page(id), live = () => { this.assertScope(); if (this.pages.get(id) !== page) throw new Error('Tab replaced'); };
      return {
        get documentId() { live(); return page.documentId; }, get ownership() { live(); return page.lease.ownership; }, get viewportId() { live(); return page.selectionViewportId; }, get picking() { return page.picking; },
        assertAgent: sessionId => { live(); page.lease.assert(page.lease.generation, sessionId); },
        takeOver: () => { live(); page.lease.takeOver(true); }, handBack: sessionId => { live(); this.handBackGroup(page, sessionId); },
        select: () => { live(); this.select(page); this.emit(); }, picker: callback => { page.agentPicker = callback ?? undefined; page.picking = callback !== null; }, pause: paused => { page.agentSelectionPaused = paused; },
        target: current => page.agentTarget(1, () => { live(); return this.selected(); }, () => Promise.reject(new Error('Inspection cannot navigate')), () => Promise.reject(new Error('Inspection cannot close pages')), AbortSignal.timeout(10000), current),
      };
    },
  });
  humanResults() { return this.interactions.results; }
  private async openCodePage(sessionId: number, signal: AbortSignal) {
    this.assertScope(); signal.throwIfAborted();
    const page = this.create('agent', sessionId), ownership = page.lease.ownership;
    const active = this.active ? this.pages.get(this.active) : undefined;
    if (!active || (active.lease.driver === 'agent' && active.lease.agentSessionId === sessionId)) this.select(page);
    try { page.ensureAgentView(); this.emit(); return await this.codeTarget(page, sessionId, signal); }
    catch (error) {
      if (this.pages.get(page.id) === page && page.lease.ownership === ownership && page.lease.driver === 'agent') await this.closePage(page).catch(() => undefined);
      throw error;
    }
  }
  private codeTarget(page: BrowserPage, sessionId: number, signal: AbortSignal) {
    return page.agentTarget(sessionId, () => {
      this.assertScope(); return this.selected() && this.pages.get(page.id) === page;
    }, async (url, pending) => {
      pending.throwIfAborted(); await this.navigate(page, url);
      while (page.loading) { await delay(25, pending); if (this.pages.get(page.id) !== page) throw new Error('Tab closed'); }
      if (page.error) throw new Error(page.error);
    }, () => this.closePage(page), signal);
  }
  code(sessionId: number, command: BrowserCodeCommand, signal: AbortSignal): Promise<BrowserCodeResult> {
    this.assertAgentAccess();
    this.assertScope(); return this.codeEngine.execute(sessionId, command, signal);
  }
  readonly engine = 'desktop';
  hasContents(tabId: string): boolean { return this.pages.get(tabId)?.hasContents === true; }
  private readonly detached = new Map<string, { window: BrowserWindow; layout?: TaskBrowserLayout; heartbeat: number; sequence: number; controlsFocus: number; presentation: 'embedded' | 'stream' }>();
  hasDetached(): boolean { return this.detached.size > 0; }
  detachTab(tabId: string, window: BrowserWindow): void {
    const page = this.page(tabId);
    if (this.detached.has(tabId)) throw new Error('Tab already detached');
    if (this.active === tabId) this.clearPicker();
    page.hide(); page.lease.takeOver(false, false);
    this.detached.set(tabId, { window, heartbeat: 0, sequence: -1, controlsFocus: 0, presentation: page.presentation });
    this.rehostPage(page, window); this.surfaceEpoch++; this.emit();
  }
  returnTab(tabId: string): void {
    const view = this.detached.get(tabId), page = this.pages.get(tabId);
    if (!view) return;
    this.detached.delete(tabId);
    if (this.disposed || this.client.state(this.window.webContents.id).scope?.id !== this.scopeId) { this.destroy(); return; }
    if (page) { const restored = this.rehostPage(page); restored.presentation = view.presentation; }
    this.surfaceEpoch++; this.emit();
  }
  private rehostPage(previous: BrowserPage, window?: BrowserWindow): BrowserPage {
    if (previous.independent) { previous.displayWindow = window; previous.lease.takeOver(false, false); return previous; }
    const { id, url, documentUrl, width, theme, slowNetwork } = previous;
    const generation = previous.lease.generation + 1, by = previous.lease.by, sessionId = previous.lease.agentSessionId, paused = previous.lease.agentPaused, waiting = previous.lease.waiting;
    previous.destroy();
    // Electron cannot transfer an attached guest between renderer documents.
    // Rehost with the same task profile and tab identity, without reading forms,
    // page text or storage into the app. Location loads explicitly with user control.
    const page = this.create(by, sessionId, id);
    page.lease.takeOver(false, false); page.lease.agentPaused = paused; page.lease.waiting = waiting; page.lease.generation = generation; page.width = width;
    page.theme = theme; page.slowNetwork = slowNetwork; page.documentUrl = documentUrl; page.displayWindow = window; page.presentation = previous.presentation;
    if (url && this.selected()) void this.navigate(page, url).catch(() => undefined); else page.url = url;
    return page;
  }
  positionDetached(tabId: string, input: TaskBrowserLayout): void {
    const view = this.detached.get(tabId);
    if (!view || input.surfaceEpoch !== this.surfaceEpoch || input.sequence <= view.sequence) return;
    view.sequence = input.sequence; view.layout = input; view.heartbeat = Date.now(); this.emit();
  }
  hideDetached(tabId: string): void {
    const view = this.detached.get(tabId);
    if (view) { view.layout = undefined; this.pages.get(tabId)?.hide(); this.surfaceEpoch++; this.emit(); }
  }
  detachedSurfaces(tabId: string): readonly TaskBrowserSurface[] {
    const view = this.detached.get(tabId), page = this.pages.get(tabId);
    return view && page ? this.surfaces().filter(surface => surface.tabId === tabId).map(surface => ({ ...surface, ...(page.independent ? {} : { guest: { partition: page.partition, bootstrap: page.bootstrap } }), partition: page.independent ? '' : page.partition, bootstrap: page.bootstrap, visible: page.attached, interactive: view.layout?.inputReady === true && page.attached, zoom: view.window.webContents.getZoomFactor() })) : [];
  }
  detachedSnapshot(tabId: string, state = this.snapshot()): TaskBrowserState { return { ...state, controlsFocus: this.detached.get(tabId)?.controlsFocus ?? state.controlsFocus }; }
  applicationInputDetached(tabId: string, x?: number, y?: number): void {
    const view = this.detached.get(tabId), layout = view?.layout;
    if (!view || !layout?.visible || !layout.inputReady) return;
    if (x !== undefined && y !== undefined && x >= layout.bounds.x && x < layout.bounds.x + layout.bounds.width && y >= layout.bounds.y && y < layout.bounds.y + layout.bounds.height) return;
    this.surfaceEpoch++; view.layout = { ...layout, inputReady: false, surfaceEpoch: this.surfaceEpoch };
    const page = this.pages.get(tabId); if (page?.lease.driver === 'agent') { page.lease.generation++; page.target = undefined; } this.emit();
  }
  readonly pages = new Map<string, BrowserPage>();
  active: string | null = null;
  picked: BrowserElement | null = null;
  picking = false;
  pickerMessage: string | null = null;
  feedback = false;
  private attention:TaskBrowserState['attention'];
  ports: readonly number[] = [];
  private revision = 0;
  private surfaceEpoch = 0;
  private controlsFocus = 0;
  private focusPending: string | null = null;
  private savedIdentity = '';
  private sequence = -1;
  private layout?: TaskBrowserLayout;
  private heartbeat = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  get closed(): boolean { return this.disposed; }
  private readonly observers = new Set<() => void>();
  private readonly network: TaskBrowserNetwork;
  private readonly profile: BrowserTaskSession;
  constructor(readonly scopeId: string, readonly taskId: number,
    private readonly window: BrowserWindow, private readonly client: BackendClient,
    remote: RemoteManager, private readonly persistence: BrowserPersistence,
    private readonly key: string, profiles: BrowserTaskProfiles, readonly isRemote: boolean,
    private readonly changed: (state: TaskBrowserState) => void, private readonly selected: () => boolean,
    private readonly surfacesChanged: () => void = () => undefined, private readonly frame: (frame: TaskBrowserFrame) => void = () => undefined, private readonly applicationPort: number | null = null, private readonly defaultPresentation: 'embedded' | 'stream' = 'embedded', private readonly localOnly?: { readonly serverProxy?: BrowserServerProxy; readonly newTab?: () => void }) {
    this.network = new TaskBrowserNetwork(isRemote, port => remote.browserForward(window.webContents.id, port), () => !this.disposed && this.client.state(this.window.webContents.id).scope?.id === this.scopeId, selected, port => port === this.applicationPort, localOnly?.serverProxy);
    this.profile = new BrowserTaskSession(
      key, profiles,
      session => this.network.configure(session),
      url => this.network.allowed(url),
      contentsId => {
        for (const page of this.pages.values()) if (page.hasContents && page.contents.id === contentsId) page.countError();
      },
      contentsId => this.allowDownload(contentsId),
      (contentsId, message, outside = false) => { const page = [...this.pages.values()].find(page => page.hasContents && page.contents.id === contentsId); this.attention = { kind: 'download', message, outside: outside && !!page, ...(page ? {tabId: page.id} : {}) }; this.emit(); },
      (contentsId, item) => [...this.pages.values()].find(page => page.hasContents && page.contents.id === contentsId)?.acceptAgentDownload(item) ?? false,
    );
  }

  private allowDownload(contentsId: number): boolean {
    const page = [...this.pages.values()].find(page => page.hasContents && page.contents.id === contentsId);
    if (!page || (this.active !== page.id && !this.detached.has(page.id)) || !this.selected() || !(this.detached.has(page.id) ? this.detached.get(page.id)?.layout : this.layout)?.visible) return false;
    if (page.lease.driver === 'agent') {
      page.lease.takeOver(true);
      this.attention = { kind: 'download', message: 'The site requested a download. Continue it yourself.', outside: false, tabId: page.id };
      this.emit(); return false;
    }
    return page.userDownloadIntent;
  }

  async restore(): Promise<void> {
    const saved = await this.persistence.read(this.key);
    this.assertScope();
    if (!saved) return;
    for (const item of saved.tabs) {
      const page = this.create(this.localOnly ? 'you' : item.by ?? 'you', this.localOnly ? null : item.agentSessionId ?? null); page.width = item.width;
      page.lease.takeOver(false, false);
      // Restored URLs load lazily on selection. No actions, handoffs or input are replayed.
      page.url = item.url; page.documentUrl = item.url;
    }
    this.active = [...this.pages.keys()][saved.active] ?? [...this.pages.keys()][0] ?? null;
    if (this.active) { const active = this.pages.get(this.active); if (active?.url) void this.navigate(active, active.url).catch(() => { active.error = 'Task server unavailable. Retry to reconnect.'; this.emit(); }); }
    this.emit();
  }
  snapshot(): TaskBrowserState { return { ...(this.localOnly ? {} : { agentCode: 1 as const, elementSnapshots: 1 as const }), agentRequests: this.interactions.pending, capabilities: { embedded: true, audio: true, accessibility: true, filePicker: true, downloads: true }, canDetach: true, canReorder: true, scopeId: this.scopeId, taskId: this.taskId, revision: this.revision, surfaceEpoch: this.surfaceEpoch, controlsFocus: this.controlsFocus,
    active: this.active, tabs: [...this.pages.values()].map(page => {
      const tab = { ...page.snapshot(), detached: this.detached.has(page.id), ...(this.localOnly ? { execution: 'local' as const, agentAccess: 'unavailable' as const, routing: this.localOnly.serverProxy ? 'server' as const : 'device' as const, driver: 'you' as const, waiting: false } : {}) };
      try { const url = new URL(tab.url); if (loopback(url) && this.ports.includes(Number(url.port || (url.protocol === 'https:' ? 443 : 80)))) return { ...tab, server: 'Task server' }; } catch { /* Empty tab. */ }
      return tab;
    }), picked: this.picked,
    capturePending: this.interactions.capturing || [...this.pages.values()].some(page => page.capturePending),
    picking: this.picking || [...this.pages.values()].some(page => page.picking && !!page.agentPicker), pickerMessage: this.pickerMessage, feedback: this.feedback, ports: this.ports, privacy: 'content-withheld', ...(this.attention ? { attention: this.attention } : {}) }; }
  private create(by: 'you' | 'agent', sessionId: number | null = null, tabId?: string): BrowserPage {
    this.assertScope();
    if (by === 'agent') this.assertAgentAccess();
    if (this.pages.size >= 12 && (!tabId || !this.pages.has(tabId))) throw new Error('A task can have up to 12 browser tabs. Close a tab first.');
    const page = new BrowserPage({ window: this.window, scopeId: this.scopeId, taskId: this.taskId, frame: this.frame, session: this.profile.session, partition: this.profile.partition,
      popup: (sessionId, options) => { const popup = this.create('agent', sessionId); this.relatedTabs.link(popup.id, page.id); popup.ensureAgentView(options); this.emit(); return popup.contents; },
      resourceUrl: url => this.network.allowed(url) ? url : null, logicalUrl: url => url, configure: () => this.profile.configure(), authorize: async url => { await this.network.authorize(browserUrl(url)); },
      authorized: () => this.selected() && this.client.state(this.window.webContents.id).scope?.id === this.scopeId,
      changed: () => this.emit(), controlChanged: () => this.synchronizeControls(), pick: element => {
        this.picked = element; this.picking = !element && page.visualPicking; page.picking = this.picking;
        this.pickerMessage = element ? null : page.visualPicking ? 'The page changed or this element could not be captured. Pick it again.' : 'Editable fields and embedded frames are private. Pick another element.';
        if (element || !page.visualPicking) { this.hide(); this.window.webContents.focus(); }
        this.emit();
      }, shortcut: kind => {
        if (page.displayWindow) { const view = this.detached.get(page.id); if (view) view.controlsFocus++; this.emit(); page.displayWindow.webContents.focus(); return; }
        if (kind === 'controls') { this.controlsFocus++; this.emit(); this.window.webContents.focus(); return; }
        this.window.webContents.focus();
        if (kind === 'open') { if (this.localOnly?.newTab) this.localOnly.newTab(); else { const next = this.create('you'); this.select(next); this.emit(); } }
        else void this.command({ kind: 'pick', enabled: !this.picking, visual: 1 }).catch(() => undefined);
      }, attention: (kind, message) => { this.attention = { kind, message, outside: true, tabId: page.id }; this.emit(); } }, by, sessionId, tabId);
    page.presentation = this.defaultPresentation;
    this.pages.set(page.id, page); return page;
  }
  async command(input: TaskBrowserCommand): Promise<TaskBrowserState> {
    this.assertScope();
    if (input.kind === 'handoff' || (input.kind === 'pick' && input.enabled) || (input.kind === 'feedback' && input.enabled) || input.kind.startsWith('agent-request-')) this.assertAgentAccess();
    if (input.kind === 'agent-request-complete' || input.kind === 'agent-request-cancel' || input.kind === 'agent-request-pick') { await this.interactions.viewer(input.kind, input.requestId, input.kind === 'agent-request-pick' && input.visual === 1); return this.snapshot(); }
    if (input.kind === 'handoff') { const request = this.interactions.pending.find(request => this.relatedTabs.members(input.tabId).includes(request.tabId)); if (request) { await this.interactions.viewer('agent-request-complete', request.id); return this.snapshot(); } }
    if (input.kind === 'dialog-response' || input.kind === 'choose-files' || input.kind === 'save-download' || input.kind === 'cancel-workflow') throw new Error('This site request belongs to a streamed browser.');
    if (input.kind === 'move-tab') {
      const page = this.page(input.tabId);
      if (input.beforeTabId !== null) this.page(input.beforeTabId);
      if (input.beforeTabId === page.id) return this.snapshot();
      const ordered = [...this.pages.values()].filter(item => item !== page);
      ordered.splice(input.beforeTabId === null ? ordered.length : ordered.findIndex(item => item.id === input.beforeTabId), 0, page);
      this.pages.clear(); for (const item of ordered) this.pages.set(item.id, item);
    }
    else if (input.kind === 'dismiss-attention') this.attention=undefined;
    else if (input.kind === 'new-tab') this.select(this.create('you'));
    else if (input.kind === 'open') {
      const page = this.create('you'); page.userDownloadIntent = true; this.select(page); await this.navigate(page, input.url);
    } else if (input.kind === 'pick') {
      const page = this.current(); page.lease.takeOver(); this.clearPicker(); this.picking = input.enabled; page.picking = input.enabled; page.visualPicking = input.visual === 1;
    } else if (input.kind === 'feedback') this.feedback = input.enabled;
    else {
      const page = this.page(input.tabId);
      if (input.kind === 'select') { this.select(page); if (page.url && (!page.hasContents || !page.contents.getURL() || page.contents.getURL() === 'about:blank')) await this.navigate(page, page.url); }
      else if (input.kind === 'close') {
        await this.closePage(page);
      } else if (input.kind === 'takeover') page.lease.stopAgent();
      else if (input.kind === 'focus') {
        if (!page.url || page.loading || page.error) throw new Error('Wait for the page to finish loading');
        if (page.lease.driver === 'agent') page.lease.takeOver();
        this.focusPending = page.id;
      }
      else if (input.kind === 'handoff') {
        const generation = page.lease.generation;
        const authorized = await this.client.execute(this.window.webContents.id, this.scopeId, null, false, async (endpoint, signal) => {
          const value = record(await requestBackendJson(endpoint, { path: '/api/desktop-browser/authorize', method: 'POST', body: { taskId: this.taskId, sessionId: input.sessionId } }, signal));
          if (value['taskId'] !== this.taskId || value['sessionId'] !== input.sessionId || value['available'] !== true) throw new Error('Invalid browser session');
          return true;
        });
        this.assertScope();
        if (!authorized.ok || !this.selected() || this.pages.get(page.id) !== page || page.lease.generation !== generation) throw new Error('Browser control changed. Hand control back explicitly when ready.');
        this.handBackGroup(page, input.sessionId); page.target = undefined; page.step = { n: 1, text: 'Waiting for a browser action' };
      }
      else if (input.kind === 'width') page.width = input.width;
      else if (input.kind === 'navigate') { page.userDownloadIntent = true; page.lease.takeOver(); await this.navigate(page, input.url); }
      else if (input.kind === 'outside') {
        const actual = await this.network.outside(browserUrl(page.url)); this.assertScope();
        if (!this.selected() || this.pages.get(page.id) !== page) throw new Error('Browser selection changed');
        // Opening outside is an explicit, validated user intent, including a remote forward.
        await shell.openExternal(actual);
      } else if (input.kind === 'back') { if (this.active === page.id) this.clearPicker(); page.lease.takeOver(); if (page.hasContents && page.contents.navigationHistory.canGoBack()) page.contents.navigationHistory.goBack(); }
      else if (input.kind === 'forward') { if (this.active === page.id) this.clearPicker(); page.lease.takeOver(); if (page.hasContents && page.contents.navigationHistory.canGoForward()) page.contents.navigationHistory.goForward(); }
      else if (input.kind === 'reload') {
        if (!page.url) return this.snapshot();
        page.userDownloadIntent = true; page.lease.takeOver();
        if (!page.hasContents) {
          if (this.active === page.id) this.clearPicker();
          // Replace only the engine. Tab position, settings and any companion
          // remain attached to the same task-owned resource identity.
          this.rehostPage(page, page.displayWindow);
        } else await this.navigate(page, page.url);
      }
      else if (input.kind === 'theme') await page.tool('theme', input.theme);
      else if (input.kind === 'network') await page.tool('network', input.slow);
    }
    this.assertScope(); this.emit(); this.persist(); return this.snapshot();
  }
  async agent(input: BrowserAgentCommand, sessionId: number, signal?: AbortSignal): Promise<BrowserAgentState> {
    this.assertAgentAccess();
    this.assertScope(); signal?.throwIfAborted();
    if (!this.selected()) throw new Error('Task is no longer selected');
    if (input.kind !== 'list') {
      const page = input.kind === 'open' ? this.create('agent', sessionId) : this.page(input.tabId);
      if (input.kind === 'open') {
        const active = this.active ? this.pages.get(this.active) : undefined;
        if (!active || (active.lease.driver === 'agent' && active.lease.agentSessionId === sessionId)) this.select(page);
      } else page.lease.assert(input.generation, sessionId);
      const generation = page.lease.generation;
      const abort = () => {
        // An old deadline must never revoke a user's takeover or a newer handoff.
        if (this.pages.get(page.id) !== page || page.lease.driver !== 'agent' || page.lease.generation !== generation) return;
        page.lease.takeOver(); page.target = undefined;
        if (page.loading && page.hasContents && !page.contents.isLoadingMainFrame()) {
          page.loading = false; page.error = 'Browser work was interrupted. Check the server, then retry explicitly.';
        }
        this.emit();
      };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (signal?.aborted) { abort(); signal.throwIfAborted(); }
        if (input.kind === 'open') await this.navigate(page, input.url, generation);
        else if (input.kind === 'select') {
          const active = this.active ? this.pages.get(this.active) : undefined;
          if (active && active !== page && (active.lease.driver !== 'agent' || active.lease.agentSessionId !== sessionId)) throw new Error('The active tab requires user selection or explicit handoff');
          this.select(page);
        } else if (input.kind === 'close') {
          if (page.lease.by === 'you') throw new Error('User-created tabs can only be closed in the desktop');
          await this.closePage(page);
        } else if (input.kind === 'needs-user') { page.lease.takeOver(true); page.step = undefined; page.target = undefined; }
        else if (input.kind === 'navigate') await this.navigate(page, input.url, input.generation);
        else if (input.kind === 'reload') await this.navigate(page, page.url, input.generation);
        else if (input.kind === 'back') { if (page.hasContents && page.contents.navigationHistory.canGoBack()) page.contents.navigationHistory.goBack(); }
        else if (input.kind === 'click') await page.click(input.x, input.y, input.generation, input.step, input.n, input.total);
        else if (input.kind === 'scroll') await page.scroll(input.x, input.y, input.generation, input.atX, input.atY);
      } finally { signal?.removeEventListener('abort', abort); }
    }
    signal?.throwIfAborted();
    this.assertScope(); this.emit(); this.persist();
    // No URLs, titles, page text, selector metadata, screenshots or raw errors go to agents.
    return { active: this.active, tabs: [...this.pages.values()].map(page => ({ id: page.id, by: page.lease.by, agentSessionId: page.lease.agentSessionId, driver: page.lease.driver, generation: page.lease.generation,
      loading: page.loading, ready: page.ready, error: page.error ? 'Page unavailable; ask the user to inspect it.' : null,
      ...(this.feedback && page.lease.driver === 'agent' ? { errors: page.errors } : {}) })), observation: 'withheld',
      message: 'Text, screenshots, accessibility, editable fields and raw logs are withheld for privacy. Ask the user to inspect the page or explicitly share context. Input requires the current control generation.' };
  }
  position(input: TaskBrowserLayout): void {
    if (input.surfaceEpoch !== this.surfaceEpoch || input.sequence <= this.sequence) return;
    const page = this.active ? this.pages.get(this.active) : undefined, ready = page?.ready;
    this.sequence = input.sequence; this.layout = input; this.heartbeat = Date.now(); this.place(); this.surfacesChanged();
    if (page && page.ready !== ready) this.emit();
  }
  surfaces(): readonly TaskBrowserSurface[] {
    if (this.disposed) return [];
    return [...this.pages.values()].filter(page => page.requested).map(page => ({ scopeId: this.scopeId, taskId: this.taskId, tabId: page.id, ...(this.detached.has(page.id) || page.independent ? {} : { guest: { partition: page.partition, bootstrap: page.bootstrap } }), partition: this.detached.has(page.id) || page.independent ? '' : page.partition, bootstrap: page.bootstrap,
      bounds: page.bounds, viewport: page.viewport, zoom: this.window.webContents.getZoomFactor(), visible: page.attached && !this.detached.has(page.id), generation: page.lease.generation, driver: page.lease.driver, interactive: this.layout?.inputReady === true && !this.picked && page.attached, presentation: page.presentation }));
  }
  attach(contents: import('electron').WebContents, tabId: string): boolean {
    const page = [...this.pages.values()].find(page => page.id === tabId && page.accepts(contents));
    if (!page) return false;
    page.attach(contents); this.emit(); return true;
  }
  presentation(tabId: string, value: 'embedded' | 'stream'): void {
    this.assertScope(); if (this.detached.has(tabId)) throw new Error('Return this tab before changing its display'); const page = this.page(tabId); if (page.independent && value !== 'stream') throw new Error('Agent-created tabs use streaming presentation'); page.hide(); page.lease.takeOver(false, false); page.presentation = value; this.emit();
  }
  acknowledge(tabId: string, stream: string, sequence: number): void { this.page(tabId).acknowledge(stream, sequence); }
  async userInput(tabId: string, generation: number, input: TaskBrowserStreamInput): Promise<number> {
    this.assertScope(); const page = this.page(tabId);
    const view = this.detached.get(tabId), layout = view?.layout ?? (view ? undefined : this.layout), heartbeat = view?.heartbeat ?? this.heartbeat;
    if (!this.selected() || (!view && this.active !== tabId) || (!view && this.picked) || !layout?.visible || !layout.inputReady || Date.now() - heartbeat > 750) throw new Error('Browser is not interactive');
    const events = input.kind === 'batch' ? input.events : [input];
    let expected = generation;
    for (let index = 0; index < events.length; index++) {
      if (!view && this.picked && events.slice(index).every(event => event.kind === 'pointer' && (event.type === 'up' || event.type === 'move'))) break;
      this.assertScope();
      if (!this.selected() || (!view && this.active !== tabId) || !(view?.layout ?? (view ? undefined : this.layout))?.inputReady) throw new Error('Browser input was interrupted');
      const accepted = page.lease.driver === 'agent' ? expected + 1 : expected;
      await page.userInput(expected, events[index]!);
      expected = page.lease.generation;
      if (expected !== accepted && index < events.length - 1) throw new Error('Browser document or control changed during input');
    }
    this.emit(); return page.lease.generation;
  }
  setPorts(ports: readonly number[]): void {
    if (ports.join(',') !== this.ports.join(',')) { this.ports = ports; this.network.authorizePorts(ports); this.emit(); }
  }
  maintain(): void {
    if (this.disposed) return;
    try { this.assertScope(); } catch { this.destroy(); return; }
    for (const [tabId, view] of this.detached) if (view.layout && (Date.now() - view.heartbeat > 750 || !view.window.isVisible() || view.window.isMinimized())) this.hideDetached(tabId);
    if ((Date.now() - this.heartbeat > 750 || !this.window.isVisible() || this.window.isMinimized()) && (this.layout || [...this.pages.values()].some(page => page.attached && !this.detached.has(page.id)))) this.hide();
  }
  applicationInput(x?: number,y?: number):void {
    const layout=this.layout;if(!layout?.visible||!layout.inputReady)return;
    if(x!==undefined&&y!==undefined&&x>=layout.bounds.x&&x<layout.bounds.x+layout.bounds.width&&y>=layout.bounds.y&&y<layout.bounds.y+layout.bounds.height)return;
    this.surfaceEpoch++;this.layout={...layout,inputReady:false,surfaceEpoch:this.surfaceEpoch};
    const page=this.active?this.pages.get(this.active):undefined;if(page?.lease.driver==='agent'){page.lease.generation++;page.target=undefined;}this.place();this.emit();
  }
  hide(): void { this.layout = undefined; this.focusPending = null; this.surfaceEpoch++; for (const page of this.pages.values()) if (!this.detached.has(page.id)) page.hide(); this.emit(); }
  suspend(): void { this.revoke(true); if (!this.hasDetached()) { this.network.pause(); for (const page of this.pages.values()) page.pauseNetwork(); } }
  revoke(retainDetached = false): void {
    this.clearPicker();
    this.hide();
    if (!retainDetached) for (const tabId of this.detached.keys()) this.hideDetached(tabId);
    for (const page of this.pages.values()) {
      if (retainDetached && this.detached.has(page.id)) continue;
      page.lease.takeOver(false, false);
      if (page.loading && page.hasContents && !page.contents.isLoadingMainFrame()) {
        page.loading = false; page.error = 'Browser work was interrupted. Check the server, then retry explicitly.';
      }
    }
    this.emit();
  }
  private place(): void {
    for (const [tabId, view] of this.detached) {
      const page = this.pages.get(tabId), layout = view.layout;
      if (!page || !layout?.visible || !view.window.isVisible() || view.window.isMinimized() || Date.now() - view.heartbeat > 750) { page?.hide(); continue; }
      const zoom = view.window.webContents.getZoomFactor(), bounds = view.window.getContentBounds();
      page.reducedMotion = layout.reducedMotion;
      page.show(intersect({ x: layout.bounds.x * zoom, y: layout.bounds.y * zoom, width: layout.bounds.width * zoom, height: layout.bounds.height * zoom }, bounds.width, bounds.height), zoom, layout.ownerGeneration, layout.inputReady, layout.viewport);
      if (this.focusPending === page.id && page.attached) { this.focusPending = null; page.focus(); }
    }
    for (const page of this.pages.values()) if (page.id !== this.active && !this.detached.has(page.id)) page.hide();
    if (this.active && this.detached.has(this.active)) return;
    const page = this.active ? this.pages.get(this.active) : undefined;
    const layout = this.layout;
    if (!page || (!page.url && !page.independent) || !layout?.visible || this.disposed || this.window.isDestroyed() || !this.window.isVisible() || this.window.isMinimized()) { page?.hide(); return; }
    const viewport = this.window.getContentBounds();
    page.reducedMotion = layout.reducedMotion;
    const zoom = this.window.webContents.getZoomFactor();
    page.show(intersect({ x: layout.bounds.x * zoom, y: layout.bounds.y * zoom, width: layout.bounds.width * zoom, height: layout.bounds.height * zoom }, viewport.width, viewport.height), zoom, layout.ownerGeneration, layout.inputReady && !this.picked, layout.viewport);
    if (this.focusPending === page.id && page.attached) { this.focusPending = null; page.focus(); }
  }
  private clearPicker(): void {
    this.picked = null; this.pickerMessage = null; this.picking = false;
    for (const other of this.pages.values()) other.picking = false;
  }
  private async closePage(page: BrowserPage): Promise<void> {
    this.relatedTabs.remove(page.id);
    this.interactions.pageClosed(page.id);
    this.clearPicker();
    if (this.attention?.tabId === page.id) this.attention = undefined;
    // Closing a companion tab must not rehost a replacement page on the way out.
    this.detached.delete(page.id); page.destroy(); this.pages.delete(page.id);
    if (this.active !== page.id) return;
    this.hide(); this.active = [...this.pages.keys()].at(-1) ?? null;
    const next = this.active ? this.pages.get(this.active) : undefined;
    if (next?.url && !next.requested) await this.navigate(next, next.url);
  }
  private select(page: BrowserPage): void {
    if (this.active !== page.id) this.hide();
    this.active = page.id; this.clearPicker();
  }
  private async navigate(page: BrowserPage, url: string, generation?: number): Promise<void> {
    if (this.active === page.id) this.clearPicker();
    const logical = browserUrl(url), expectedGeneration = page.lease.generation;
    page.url = logical; page.loading = true; page.error = null; this.emit();
    try {
      await this.network.authorize(logical);
      await page.configureNetwork(); this.assertScope();
      if (!this.pages.has(page.id) || page.lease.generation !== expectedGeneration) throw new Error('Browser control or navigation changed');
      if (generation !== undefined) page.lease.assert(generation);
      page.load(logical, logical);
      this.assertScope();
    } catch (error) {
      if (this.pages.has(page.id) && page.lease.generation === expectedGeneration) {
        page.loading = false; page.error = 'The task server connection is unavailable. Check the server, then retry.'; this.emit();
      }
      throw error;
    }
  }
  private current(): BrowserPage { if (!this.active) throw new Error('Open a browser tab first'); return this.page(this.active); }
  private page(id: string): BrowserPage { const page = this.pages.get(id); if (!page) throw new Error('Browser tab is no longer open'); return page; }
  private assertScope(): void { if (this.disposed || this.client.state(this.window.webContents.id).scope?.id !== this.scopeId) throw new Error('Browser scope changed. Reopen the task browser.'); }
  private assertAgentAccess(): void { if (this.localOnly) throw new Error('Local tabs on a remote task are unavailable to agents. Open a remote tab to work with the agent.'); }
  private persist(): void {
    const savedPages=[...this.pages.values()].filter(page=>page.documentUrl);
    const tabs: SavedBrowser['tabs'] = savedPages.map(page => {
      const url = new URL(page.documentUrl); url.search = ''; url.hash = '';
      return { url: url.href, width: page.width, by: page.lease.by, agentSessionId: page.lease.agentSessionId };
    });
    const saved = { active: Math.max(0, savedPages.findIndex(page=>page.id===this.active)), tabs };
    const identity = JSON.stringify(saved);
    if (identity === this.savedIdentity) return;
    this.savedIdentity = identity; this.persistence.save(this.key, saved);
  }
  private emit(): void {
    if (this.disposed) return;
    this.revision++;
    for (const observer of this.observers) observer();
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; if (!this.disposed) { this.place(); this.changed(this.snapshot()); this.surfacesChanged(); this.persist(); } }, 16);
  }
  destroy(): void {
    if (this.disposed) return;
    this.interactions.dispose();
    this.codeEngine.dispose();
    this.persist(); this.disposed = true; if (this.timer) clearTimeout(this.timer);
    for (const page of this.pages.values()) page.destroy(); this.pages.clear();
    this.observers.clear(); this.detached.clear(); this.network.close(); this.profile.destroy(); this.surfacesChanged();
  }
}
