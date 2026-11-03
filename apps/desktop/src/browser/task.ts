import { TaskBrowserNetwork } from './network';
import type { BrowserAgentCommand, BrowserAgentState, BrowserElement, TaskBrowserCommand, TaskBrowserLayout, TaskBrowserState } from '@elevenex/shared';
import { shell, type BrowserWindow } from 'electron';
import { requestBackendJson } from '../backend-client/transport';
import { record } from './validation';
import type { BackendClient } from '../backend-client/client';
import type { RemoteManager } from '../remote/manager';
import { BrowserPage } from './surface';
import { browserUrl, intersect, loopback } from './validation';
import type { BrowserPersistence, SavedBrowser } from './persistence';

/** Task workspace lifetime, independent of the selected conversation and panel. */
export class TaskBrowser {
  readonly pages = new Map<string, BrowserPage>();
  active: string | null = null;
  picked: BrowserElement | null = null;
  picking = false;
  pickerMessage: string | null = null;
  feedback = false;
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
  private readonly network: TaskBrowserNetwork;
  constructor(readonly scopeId: string, readonly taskId: number,
    private readonly window: BrowserWindow, private readonly client: BackendClient,
    remote: RemoteManager, private readonly persistence: BrowserPersistence,
    private readonly key: string, readonly isRemote: boolean,
    private readonly changed: (state: TaskBrowserState) => void, private readonly selected: () => boolean) {
    this.network = new TaskBrowserNetwork(isRemote, port => remote.browserForward(window.webContents.id, port), () => !this.disposed && this.client.state(this.window.webContents.id).scope?.id === this.scopeId, selected);
  }

  async restore(): Promise<void> {
    const saved = await this.persistence.read(this.key);
    this.assertScope();
    if (!saved) return;
    for (const item of saved.tabs) {
      const page = this.create(item.by ?? 'you', item.agentSessionId ?? null); page.width = item.width;
      page.lease.takeOver();
      // Restored URLs load lazily on selection. No actions, handoffs or input are replayed.
      page.url = item.url;
    }
    this.active = [...this.pages.keys()][saved.active] ?? [...this.pages.keys()][0] ?? null;
    if (this.active) { const active = this.pages.get(this.active); if (active?.url) void this.navigate(active, active.url).catch(() => { active.error = 'Task server unavailable. Retry to reconnect.'; this.emit(); }); }
    this.emit();
  }
  snapshot(): TaskBrowserState { return { scopeId: this.scopeId, taskId: this.taskId, revision: this.revision, surfaceEpoch: this.surfaceEpoch, controlsFocus: this.controlsFocus,
    active: this.active, tabs: [...this.pages.values()].map(page => {
      const tab = page.snapshot();
      try { const url = new URL(tab.url); if (loopback(url) && this.ports.includes(Number(url.port || (url.protocol === 'https:' ? 443 : 80)))) return { ...tab, server: 'Task server' }; } catch { /* Empty tab. */ }
      return tab;
    }), picked: this.picked,
    picking: this.picking, pickerMessage: this.pickerMessage, feedback: this.feedback, ports: this.ports, privacy: 'content-withheld' }; }
  private create(by: 'you' | 'agent', sessionId: number | null = null): BrowserPage {
    this.assertScope();
    if (this.pages.size >= 12) throw new Error('A task can have up to 12 browser tabs. Close a tab first.');
    const page = new BrowserPage({ window: this.window,
      resourceUrl: url => this.network.allowed(url) ? url : null, logicalUrl: url => url, configure: session => this.network.configure(session),
      authorized: () => this.selected() && this.client.state(this.window.webContents.id).scope?.id === this.scopeId,
      changed: () => this.emit(), pick: element => {
        this.picked = element; this.picking = false; page.picking = false;
        this.pickerMessage = element ? null : 'Editable fields and embedded frames are private. Pick another element.';
        this.hide(); this.emit(); this.window.webContents.focus();
      }, shortcut: kind => {
        if (kind === 'controls') { this.controlsFocus++; this.emit(); this.window.webContents.focus(); return; }
        this.hide(); this.window.webContents.focus();
        if (kind === 'open') { const next = this.create('you'); this.select(next); this.emit(); }
        else { this.picking = !this.picking; page.picking = this.picking; this.emit(); }
      } }, by, sessionId);
    this.pages.set(page.id, page); return page;
  }
  async command(input: TaskBrowserCommand): Promise<TaskBrowserState> {
    this.assertScope();
    if (input.kind === 'open') {
      const page = this.create('you'); this.select(page); await this.navigate(page, input.url);
    } else if (input.kind === 'pick') {
      const page = this.current(); page.lease.takeOver(); this.picked = null; this.pickerMessage = null; this.picking = input.enabled; page.picking = input.enabled;
    } else if (input.kind === 'feedback') this.feedback = input.enabled;
    else {
      const page = this.page(input.tabId);
      if (input.kind === 'select') { this.select(page); if (page.url && !page.contents.getURL()) await this.navigate(page, page.url); }
      else if (input.kind === 'close') {
        page.destroy(); this.pages.delete(page.id);
        if (this.active === page.id) { this.hide(); this.active = [...this.pages.keys()].at(-1) ?? null; }
        this.picked = null; this.picking = false;
      } else if (input.kind === 'takeover') page.lease.takeOver();
      else if (input.kind === 'focus') {
        if (!page.url || page.loading || page.error) throw new Error('Wait for the page to finish loading');
        if (page.lease.driver === 'agent') page.lease.takeOver();
        this.focusPending = page.id;
      }
      else if (input.kind === 'handoff') {
        const authorized = await this.client.execute(this.window.webContents.id, this.scopeId, null, false, async (endpoint, signal) => {
          const value = record(await requestBackendJson(endpoint, { path: '/api/desktop-browser/authorize', method: 'POST', body: { taskId: this.taskId, sessionId: input.sessionId } }, signal));
          if (value['taskId'] !== this.taskId || value['sessionId'] !== input.sessionId || value['available'] !== true) throw new Error('Invalid browser session');
          return true;
        });
        this.assertScope();
        if (!authorized.ok || !this.selected() || !this.pages.has(page.id)) throw new Error('The conversation is unavailable for browser control');
        page.lease.handBack(input.sessionId); page.target = undefined; page.step = { n: 1, text: 'Waiting for a browser action' };
      }
      else if (input.kind === 'width') page.width = input.width;
      else if (input.kind === 'navigate') { page.lease.takeOver(); await this.navigate(page, input.url); }
      else if (input.kind === 'outside') {
        const actual = await this.network.outside(browserUrl(page.url)); this.assertScope();
        // Opening outside is an explicit, validated user intent, including a remote forward.
        await shell.openExternal(actual);
      } else if (input.kind === 'back') { page.lease.takeOver(); if (page.contents.navigationHistory.canGoBack()) page.contents.navigationHistory.goBack(); }
      else if (input.kind === 'reload') {
        page.lease.takeOver();
        if (page.contents.isDestroyed()) {
          const wasActive = this.active === page.id, url = page.url;
          page.destroy(); this.pages.delete(page.id);
          const replacement = this.create(page.lease.by, page.lease.agentSessionId);
          replacement.width = page.width; replacement.lease.takeOver();
          if (wasActive) this.select(replacement);
          await this.navigate(replacement, url);
        } else await this.navigate(page, page.url);
      }
      else if (input.kind === 'theme') await page.tool('theme', input.theme);
      else if (input.kind === 'network') await page.tool('network', input.slow);
    }
    this.assertScope(); this.emit(); this.persist(); return this.snapshot();
  }
  async agent(input: BrowserAgentCommand, sessionId: number, signal?: AbortSignal): Promise<BrowserAgentState> {
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
        if (page.loading && !page.contents.isDestroyed() && !page.contents.isLoadingMainFrame()) {
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
          page.destroy(); this.pages.delete(page.id);
          if (this.active === page.id) { this.hide(); this.active = [...this.pages.keys()].at(-1) ?? null; }
        } else if (input.kind === 'needs-user') { page.lease.takeOver(true); page.step = undefined; page.target = undefined; }
        else if (input.kind === 'navigate') await this.navigate(page, input.url, input.generation);
        else if (input.kind === 'reload') await this.navigate(page, page.url, input.generation);
        else if (input.kind === 'back') { if (page.contents.navigationHistory.canGoBack()) page.contents.navigationHistory.goBack(); }
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
    this.sequence = input.sequence; this.layout = input; this.heartbeat = Date.now(); this.place();
    if (page && page.ready !== ready) this.emit();
  }
  setPorts(ports: readonly number[]): void {
    if (ports.join(',') !== this.ports.join(',')) { this.ports = ports; this.network.authorizePorts(ports); this.emit(); }
  }
  maintain(): void {
    if (this.disposed) return;
    try { this.assertScope(); } catch { this.destroy(); return; }
    if ((Date.now() - this.heartbeat > 750 || !this.window.isVisible() || this.window.isMinimized()) && (this.layout || [...this.pages.values()].some(page => page.attached))) this.hide();
  }
  hide(): void { this.layout = undefined; this.focusPending = null; this.surfaceEpoch++; for (const page of this.pages.values()) page.hide(); this.emit(); }
  suspend(): void { this.revoke(); this.network.pause(); for (const page of this.pages.values()) page.pauseNetwork(); }
  revoke(): void {
    this.hide();
    for (const page of this.pages.values()) {
      page.lease.takeOver();
      if (page.loading && !page.contents.isDestroyed() && !page.contents.isLoadingMainFrame()) {
        page.loading = false; page.error = 'Browser work was interrupted. Check the server, then retry explicitly.';
      }
    }
    this.emit();
  }
  private place(): void {
    for (const page of this.pages.values()) if (page.id !== this.active) page.hide();
    const page = this.active ? this.pages.get(this.active) : undefined;
    const layout = this.layout;
    if (!page || !layout?.visible || this.picked || this.disposed || this.window.isDestroyed() || !this.window.isVisible() || this.window.isMinimized()) { page?.hide(); return; }
    const viewport = this.window.getContentBounds();
    page.reducedMotion = layout.reducedMotion;
    const zoom = this.window.webContents.getZoomFactor();
    page.show(intersect({ x: layout.bounds.x * zoom, y: layout.bounds.y * zoom, width: layout.bounds.width * zoom, height: layout.bounds.height * zoom }, viewport.width, viewport.height), zoom, layout.ownerGeneration, layout.inputReady);
    if (this.focusPending === page.id && page.attached) { this.focusPending = null; page.focus(); }
  }
  private select(page: BrowserPage): void {
    this.hide(); this.active = page.id; this.picked = null; this.pickerMessage = null; this.picking = false;
    for (const other of this.pages.values()) other.picking = false;
  }
  private async navigate(page: BrowserPage, url: string, generation?: number): Promise<void> {
    if (this.active === page.id) { this.picked = null; this.picking = false; page.picking = false; this.pickerMessage = null; }
    const logical = browserUrl(url), expectedGeneration = page.lease.generation;
    page.url = logical; page.loading = true; page.error = null; page.hide(); this.emit();
    try {
      await this.network.outside(logical);
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
  private persist(): void {
    const tabs: SavedBrowser['tabs'] = [...this.pages.values()].filter(p => p.url).map(page => {
      const url = new URL(page.url); url.search = ''; url.hash = '';
      return { url: url.href, width: page.width, by: page.lease.by, agentSessionId: page.lease.agentSessionId };
    });
    const saved = { active: Math.max(0, [...this.pages.keys()].indexOf(this.active ?? '')), tabs };
    const identity = JSON.stringify(saved);
    if (identity === this.savedIdentity) return;
    this.savedIdentity = identity; this.persistence.save(this.key, saved);
  }
  private emit(): void {
    if (this.disposed) return;
    this.revision++;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; if (!this.disposed) { this.place(); this.changed(this.snapshot()); this.persist(); } }, 32);
  }
  destroy(): void {
    if (this.disposed) return;
    this.persist(); this.disposed = true; if (this.timer) clearTimeout(this.timer);
    for (const page of this.pages.values()) page.destroy(); this.pages.clear();
    this.network.close();
  }
}
