import { RuntimeWorkflowBudget } from './runtime-workflows.js';
import type { BrowserContext, Page } from 'playwright-core';
import { BrowserAgentEngine, BrowserInteractionController, RelatedBrowserTabs } from '@elevenex/browser-agent';
import type { BrowserCodeCommand, BrowserCodeResult } from '@elevenex/shared';
import { RuntimeBrowserNetwork } from './runtime-network.js';
import { browserLoopbackHost } from '@elevenex/browser-network';
import type { SavedRuntimeBrowser } from './runtime-persistence.js';
import type {
  BrowserAgentCommand,
  BrowserAgentState,
  TaskBrowserCommand,
  TaskBrowserState,
  TaskBrowserStreamInput,
  TaskBrowserStreamEvent,
} from '@elevenex/shared';
import { RuntimeBrowserTab } from './runtime-tab.js';
import type { RuntimeBrowserPool } from './runtime-browser-pool.js';
import { randomUUID } from 'node:crypto';
import { RuntimeWebAuthn } from './runtime-webauthn.js';
import { RuntimeInputLane } from './runtime-input-lane.js';

/** The task owns browser execution. A viewer owns only presentation and human input. */
export class RuntimeBrowserTask {
  private readonly relatedTabs = new RelatedBrowserTabs();
  private controlUpdating = false;
  private synchronizeControls(): void {
    if (this.controlUpdating || this.disposed) return;
    this.controlUpdating = true;
    try {
      for (const tab of this.tabs.values())
        if (tab.driver !== 'agent')
          for (const id of this.relatedTabs.members(tab.id)) {
            const sibling = this.tabs.get(id);
            if (sibling?.driver === 'agent') sibling.takeover(true);
          }
    } finally {
      this.controlUpdating = false;
    }
    this.revision++;
  }
  private handBackGroup(tab: RuntimeBrowserTab, sessionId: number): void {
    const members = this.relatedTabs.members(tab.id).map((id) => this.page(id));
    if (members.some((page) => page.workflows.snapshot().length))
      throw new Error(
        'Resolve related-page site requests before returning control',
      );
    this.controlUpdating = true;
    try {
      for (const page of members) page.handoff(sessionId);
    } finally {
      this.controlUpdating = false;
    }
    this.revision++;
  }
  private readonly codeEngine = new BrowserAgentEngine({
    playwright: true,
    profile: { cookies: async () => (await this.contextForTask()).cookies(), addCookies: async cookies => (await this.contextForTask()).addCookies(cookies), clearCookies: async () => (await this.contextForTask()).clearCookies() },
    watch: listener => this.subscribe(listener),
    interact: (sessionId, command) => this.interactions.execute(sessionId, command),
    document: tabId => this.tabs.get(tabId)?.documentId,
    authorizeUrl: async (url, signal) => { signal.throwIfAborted(); this.authorize(url); },
    version: async () => (await this.contextForTask()).browser()?.version() ?? '140.0.0.0',
    proxy: () => this.network.start(),
    newPage: (sessionId, signal) => this.openCodePage(sessionId, '', signal),
    list: sessionId => [...this.tabs.values()].map(tab => ({ id: tab.id, populated: !!tab.url || tab.started, owned: tab.driver === 'agent' && tab.agentSessionId === sessionId, ...(tab.driver === 'agent' && tab.agentSessionId === sessionId ? { url: tab.url } : {}) })),
    open: (sessionId, url, signal) => this.openCodePage(sessionId, url, signal),
    get: (sessionId, tabId) => Promise.resolve(this.codeTarget(this.page(tabId), sessionId)),
  });
  private readonly interactions = new BrowserInteractionController({
    changed: () => this.revision++,
    authorize: sessionId => this.authorizeSession(sessionId),
    tab: id => {
      const tab = this.page(id), live = () => { if (!this.alive || this.tabs.get(id) !== tab) throw new Error('Tab closed or replaced'); };
      return {
        get documentId() { live(); return tab.documentId; }, get ownership() { live(); return tab.ownership; }, get viewportId() { live(); return tab.selectionViewportId; }, get picking() { return tab.picking; },
        assertAgent: sessionId => { live(); tab.assertAgent(tab.generation, sessionId); },
        takeOver: () => { live(); tab.takeover(true); }, handBack: sessionId => { live(); this.handBackGroup(tab, sessionId); },
        select: () => this.select(id), picker: callback => { tab.agentPicker = callback ?? undefined; tab.picking = callback !== null; }, pause: paused => { tab.agentSelectionPaused = paused; },
        target: current => tab.agentTarget(1, () => this.alive && this.tabs.get(id) === tab, () => Promise.reject(new Error('Inspection cannot navigate')), () => Promise.reject(new Error('Inspection cannot close pages')), undefined, listener => this.subscribe(listener), current),
      };
    },
  });
  userRequest(id: string, sessionId?: number) { return this.interactions.get(id, sessionId); }
  humanResults() { return this.interactions.results; }
  private async openCodePage(sessionId: number, url: string, signal: AbortSignal) {
    if (url) this.authorize(url);
    const tab = await this.create('agent', sessionId, '', signal), ownership = tab.ownership;
    try {
      const context = await this.contextForTask(); signal.throwIfAborted();
      await tab.start(context); signal.throwIfAborted();
      return await this.codeTarget(tab, sessionId);
    } catch (error) {
      if (this.tabs.get(tab.id) === tab && tab.ownership === ownership && tab.driver === 'agent') await this.command({ kind: 'close', tabId: tab.id }).catch(() => undefined);
      throw error;
    }
  }
  private codeTarget(tab: RuntimeBrowserTab, sessionId: number) {
    return tab.agentTarget(sessionId, () => this.alive && this.tabs.get(tab.id) === tab,
      async (url, signal) => { signal.throwIfAborted(); this.authorize(url); await tab.navigate(url); signal.throwIfAborted(); },
      async () => { await this.command({ kind: 'close', tabId: tab.id }); },
      async (url, signal) => { signal.throwIfAborted(); this.authorize(url); }, listener => this.subscribe(listener));
  }
  code(sessionId: number, command: BrowserCodeCommand, signal: AbortSignal): Promise<BrowserCodeResult> {
    return this.codeEngine.execute(sessionId, command, signal);
  }
  readonly webAuthn = new RuntimeWebAuthn(() => this.revision++, origin => {
    const matches = [...this.tabs.values()].filter(tab => {
      try { return new URL(tab.documentUrl).origin === origin; } catch { return false; }
    });
    if (!matches.some(tab => this.isPresented(tab.id))) return false;
    // Proxy API requests have origin identity, not a tab identity. Revoke agent
    // control on every matching tab before exposing a human ceremony.
    for (const tab of matches) if (tab.driver === 'agent') tab.takeover(true);
    return true;
  });
  readonly id = randomUUID();
  private readonly workflowBudget = new RuntimeWorkflowBudget();
  readonly tabs = new Map<string, RuntimeBrowserTab>();
  active: string | null = null;
  private readonly presentations = new Map<string, { width: number; height: number; visible: boolean; interactive: boolean; pixelRatio: number; colorScheme: 'light' | 'dark'; seen: number }>();
  isPresented(tabId: string): boolean {
    const view = this.presentations.get(tabId);
    return this.alive && (view ? view.visible && Date.now() - view.seen < 15000 : this.active === tabId && this.visible);
  }
  private canInput(tabId: string): boolean {
    const view = this.presentations.get(tabId);
    return this.isPresented(tabId) && (view ? view.interactive : this.interactive);
  }
  async layoutTab(tabId: string, width: number, height: number, visible: boolean, interactive: boolean, pixelRatio: number, colorScheme: 'light' | 'dark', detached = true): Promise<void> {
    const page = this.page(tabId);
    if (!detached) { this.presentations.delete(tabId); page.takeover(); await page.layout(width, height, false); this.revision++; return; }
    this.touch();
    const view = { width, height, visible, interactive, pixelRatio, colorScheme, seen: Date.now() };
    if (!this.presentations.has(tabId)) { page.takeover(); this.revision++; }
    this.presentations.set(tabId, view);
    if (visible && !page.started && page.url && !page.error) {
      this.launchForDisplay(page, () => {
        if (this.presentations.get(tabId) === view)
          return this.layoutTab(tabId, width, height, visible, interactive, pixelRatio, colorScheme);
        return Promise.resolve();
      });
      return;
    }
    if (this.presentations.get(tabId) !== view || !this.alive) return;
    if (!page.started) return;
    if (page.theme === 'system') await page.themeTo('system', colorScheme);
    if (this.presentations.get(tabId) !== view || !this.alive) return;
    await page.layout(width, height, visible, interactive, pixelRatio);
  }
  private stateRevision = 0;
  private notifying = false;
  private readonly listeners = new Set<() => void>();
  private get revision(): number { return this.stateRevision; }
  private set revision(value: number) {
    this.stateRevision = value;
    if (this.notifying || this.disposed) return;
    this.notifying = true;
    queueMicrotask(() => {
      this.notifying = false;
      if (!this.disposed) for (const listener of this.listeners) listener();
    });
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  get retained(): boolean {
    // Unviewed empty user start tabs have no live document to lose. Loaded
    // pages and agent-owned drafts always require explicit closure.
    return this.codeEngine.active || this.starting.size > 0 || this.agentPending > 0 || [...this.tabs.values()].some(tab => !!tab.url || tab.started || tab.driver === 'agent');
  }
  private controlsFocus = 0;
  private picked: TaskBrowserState['picked'] = null;
  private pickerMessage: string | null = null;
  private picking = false;
  private clearPicker(): void {
    const changed = this.picked !== null || this.pickerMessage !== null || this.picking || [...this.tabs.values()].some(tab => tab.picking);
    this.picked = null;
    this.pickerMessage = null;
    this.picking = false;
    for (const tab of this.tabs.values()) tab.picking = false;
    if (changed) this.revision++;
  }
  private feedback = false;
  private attention: TaskBrowserState['attention'];
  private ports: readonly number[] = [];
  private readonly starting = new Map<string, Promise<void>>();
  private readonly displayStarting = new Map<string, { present: () => Promise<void> }>();
  private readonly inputLanes = new Map<string, RuntimeInputLane>();
  private readonly controller = new AbortController();
  private readonly authorizedPorts = new Set<number>();
  private disposed = false;
  private visible = false;
  private interactive = false;
  private pixelRatio = 1;
  private colorScheme: 'light' | 'dark' = 'light';
  private viewport = { width: 800, height: 600 };
  private context?: Promise<BrowserContext>;
  private ownedContext?: BrowserContext;
  private layoutRevision = 0;
  private selectionRevision = 0;
  private readonly network: RuntimeBrowserNetwork;
  constructor(
    readonly taskId: number,
    private readonly pool: RuntimeBrowserPool,
    private readonly profileIdentity: string,
    private readonly authorizeSession: (sessionId: number) => Promise<void> = () => Promise.resolve(),
  ) {
    this.network = new RuntimeBrowserNetwork(
      () => this.alive,
      (port) => this.pool.isApplicationPort(port),
    );
  }
  get alive(): boolean {
    return !this.disposed;
  }
  private expirePresentations(): void {
    for (const [tabId, view] of this.presentations) if (view.visible && Date.now() - view.seen >= 15000) {
      view.visible = false; view.interactive = false;
      const page = this.tabs.get(tabId);
      void page?.layout(view.width, view.height, false); this.revision++;
    }
  }
  touch(): void {
    this.expirePresentations();
  }
  reconcile(clearRequests = true): void {
    void this.webAuthn.configure(false, false);
    this.clearPicker();
    this.layoutRevision++;
    this.selectionRevision++;
    this.visible = false;
    this.presentations.clear();
    for (const tab of this.tabs.values()) {
      if (clearRequests) void tab.workflows.clear();
      void tab.layout(this.viewport.width, this.viewport.height, false);
    }
    this.revision++;
  }
  setPorts(ports: readonly number[]): void {
    if (ports.length === this.ports.length && ports.every((port, index) => port === this.ports[index])) return;
    this.ports = [...ports];
    this.revision++;
  }
  state(): TaskBrowserState {
    return {
      agentCode: 1, elementSnapshots: 1,
      agentRequests: this.interactions.pending,
      // Advertise the private protocol before the lazy Chromium launch so clients
      // can opt in on connect without sending new fields to older engines.
      webAuthn: true,
      ...(this.webAuthn.snapshot() ? { webAuthnRequest: this.webAuthn.snapshot() } : {}),
      workflows: true,
      pointerLock: true,
      streamVersion: 1,
      videoStream: 'h264',
      videoWindow: 8,
      canDetach: true,
      canReorder: true,
      layoutLanes: true,
      keyText: true,
      pointerExit: true,
      inputWindow: 4,
      scopeId: this.id,
      taskId: this.taskId,
      revision: this.revision,
      surfaceEpoch: 0,
      controlsFocus: this.controlsFocus,
      active: this.active,
      tabs: [...this.tabs.values()].map((page) => {
        const tab = page.snapshot();
        try {
          const url = new URL(tab.url);
          if (
            browserLoopbackHost(url.hostname) &&
            this.ports.includes(
              Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
            )
          )
            return { ...tab, server: 'Task server' };
        } catch {
          /* Blank tab. */
        }
        return tab;
      }),
      picked: this.picked,
      capturePending: this.interactions.capturing || [...this.tabs.values()].some(tab => tab.capturePending),
      picking: this.picking || [...this.tabs.values()].some(tab => tab.picking && !!tab.agentPicker),
      pickerMessage: this.pickerMessage,
      feedback: this.feedback,
      ports: this.ports,
      privacy: 'content-withheld',
      ...(this.attention ? { attention: this.attention } : {}),
    };
  }
  private authorize(address: string): void {
    const url = new URL(address),
      port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (this.pool.isApplicationPort(port))
      throw new Error('Application control ports are not browser destinations');
    if (browserLoopbackHost(url.hostname)) {
      if (this.authorizedPorts.size >= 32 && !this.authorizedPorts.has(port))
        throw new Error('Task port limit reached');
      this.authorizedPorts.add(port);
      for (const tab of this.tabs.values())
        tab.setPorts([...this.authorizedPorts]);
    }
  }
  restore(saved: SavedRuntimeBrowser): void {
    for (const item of saved.tabs) {
      try {
        this.authorize(item.url);
      } catch {
        continue;
      }
      const tab = this.makeTab(item.by, item.agentSessionId);
      tab.url = item.url;
      tab.documentUrl = item.url;
      tab.width = item.width;
      tab.driver = 'you';
      tab.loading = true;
      this.tabs.set(tab.id, tab);
    }
    this.active =
      [...this.tabs.keys()][saved.active] ?? [...this.tabs.keys()][0] ?? null;
    this.revision++;
  }
  saved(): SavedRuntimeBrowser {
    return {
      active: Math.max(
        0,
        [...this.tabs.values()]
          .filter((tab) => tab.documentUrl)
          .findIndex((tab) => tab.id === this.active),
      ),
      tabs: [...this.tabs.values()]
        .filter((tab) => tab.documentUrl)
        .map((tab) => {
          const url = new URL(tab.documentUrl);
          url.search = '';
          url.hash = '';
          return {
            url: url.href,
            width: tab.width,
            by: tab.by,
            agentSessionId: tab.agentSessionId,
          };
        }),
    };
  }
  private contextForTask(): Promise<BrowserContext> {
    return (this.context ??= (async () => {
      if (this.disposed || !this.alive) throw new Error('Browser task closed');
      const proxy = await this.network.start();
      const context = await this.pool.acquire(this.profileIdentity, {
        viewport: this.viewport,
        // Playwright maps an explicit empty grant list to Chromium's reject-all
        // override. Omitting it would leave browser permission prompts pending.
        permissions: [],
        acceptDownloads: true,
        proxy: { server: proxy, bypass: '<-loopback>' },
        serviceWorkers: 'allow',
      });
      this.ownedContext = context;
      await this.webAuthn.start(context);
      context.once('close', () => {
        if (this.ownedContext === context) {
          this.ownedContext = undefined;
          this.context = undefined;
          this.layoutRevision++;
          this.revision++;
        }
      });
      if (this.disposed) {
        await context.close();
        throw new Error('Browser task closed');
      }
      context.on('page', popup => {
        if (context.pages().filter(page => !this.pool.isWindowAnchor(page)).length > 12) { void popup.close().catch(() => undefined); return; }
        void this.adoptPopup(context, popup).catch(() => popup.close().catch(() => undefined));
      });
      return context;
    })().catch((error) => {
      this.context = undefined;
      throw error;
    }));
  }
  private async adoptPopup(context: BrowserContext, popup: Page): Promise<void> {
    const opener = await popup.opener();
    if (!opener) return; // Ordinary tabs are adopted by ensure().
    const origin = [...this.tabs.values()].find(tab => tab.owns(opener));
    if (!origin || !this.alive || this.tabs.size >= 12) { await popup.close(); return; }
    const driven = origin.agentPlaywright;
    if (!driven) origin.takeover(true);
    const tab = this.makeTab(driven ? 'agent' : 'you', driven ? origin.agentSessionId : null);
    // Keep the actual page in this context: OAuth relies on window.opener,
    // postMessage, window.close and the task's shared cookies.
    this.tabs.set(tab.id, tab);
    this.relatedTabs.link(tab.id, origin.id);
    popup.once('close', () => {
      if (!this.alive || this.tabs.get(tab.id) !== tab) return;
      this.relatedTabs.remove(tab.id); this.interactions.pageClosed(tab.id);
      this.tabs.delete(tab.id); this.presentations.delete(tab.id);
      if (this.active === tab.id) {
        this.active = this.tabs.has(origin.id) ? origin.id : [...this.tabs.keys()].at(-1) ?? null;
        if (this.active) void this.select(this.active).catch(() => undefined);
      }
      void tab.destroy(); this.revision++;
    });
    await tab.start(context, popup);
    if (!this.alive || !this.tabs.has(tab.id)) return;
    if (this.active === origin.id) await this.select(tab.id);
    this.revision++;
  }
  private makeTab(by: 'you' | 'agent', sessionId: number | null): RuntimeBrowserTab {
    const tab = new RuntimeBrowserTab(by, sessionId, () => this.alive, () => this.revision++, element => {
      this.picked = element;
      this.pickerMessage = element ? null : tab.visualPicking ? 'The page changed or this element could not be captured. Pick it again.' : 'Editable fields and embedded content are private. Pick another element.';
      this.picking = false; tab.picking = false; this.revision++;
    }, this.network, (kind, message) => {
      this.attention = { kind, message, outside: true, tabId: tab.id }; this.revision++;
    }, this.workflowBudget, () => this.synchronizeControls());
    return tab;
  }
  private async ensure(
    page: RuntimeBrowserTab,
    signal = this.controller.signal,
    assertOwnership?: () => void,
  ): Promise<void> {
    if (page.started || !page.url) return;
    if (page.error) return; // A failed engine requires explicit human Reload.
    let pending = this.starting.get(page.id);
    if (!pending) {
      pending = (async () => {
        const context = await this.contextForTask();
        signal.throwIfAborted();
        await page.start(context);
        signal.throwIfAborted();
        if (this.disposed || !this.alive)
          throw new Error('Browser task closed');
        page.setPorts([...this.authorizedPorts]);
        await page.themeTo(page.theme, this.colorScheme);
        if (page.slowNetwork) await page.networkTo(true);
        signal.throwIfAborted();
        // A start tab may lose agent ownership while its engine is launching.
        assertOwnership?.();
        await page.navigate(page.url);
      })().finally(() => this.starting.delete(page.id));
      this.starting.set(page.id, pending);
    }
    await pending;
  }
  private launchForDisplay(page: RuntimeBrowserTab, present: () => Promise<void>): void {
    // Installation belongs to the task, not a short layout RPC. Keep
    // heartbeats and input on other pages moving while this engine starts.
    const previous = this.displayStarting.get(page.id);
    if (previous) { previous.present = present; return; }
    const entry = { present };
    this.displayStarting.set(page.id, entry);
    void this.ensure(page).then(async () => {
      if (this.alive && this.tabs.get(page.id) === page) await entry.present();
    }).catch(() => {
      if (!this.alive || this.tabs.get(page.id) !== page) return;
      page.loading = false;
      page.error = 'The browser could not start. Check the host setup, then Reload to retry.';
      this.revision++;
    }).finally(() => this.displayStarting.delete(page.id));
  }
  async create(
    by: 'you' | 'agent',
    sessionId: number | null,
    url: string,
    signal?: AbortSignal,
  ): Promise<RuntimeBrowserTab> {
    if (url) this.authorize(url);
    if (this.tabs.size >= 12) throw new Error('Task browser tab limit reached');
    const tab = this.makeTab(by, sessionId);
    const previous = this.active;
    tab.url = url;
    tab.loading = !!url;
    this.tabs.set(tab.id, tab);
    if (
      by === 'you' ||
      !previous ||
      (this.page(previous).driver === 'agent' &&
        this.page(previous).agentSessionId === sessionId)
    ) {
      this.clearPicker();
      if (previous && !this.presentations.has(previous))
        void this.page(previous).layout(
          this.viewport.width,
          this.viewport.height,
          false,
        );
      this.active = tab.id;
    }
    this.revision++;
    const ownership = tab.ownership;
    const abort = () => {
      if (tab.ownership !== ownership) return;
      tab.takeover();
      this.revision++;
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      if (!this.alive) throw new Error('Browser viewer disconnected');
      await this.ensure(
        tab,
        signal
          ? AbortSignal.any([signal, this.controller.signal])
          : this.controller.signal,
      );
      signal?.throwIfAborted();
      if (!this.alive) throw new Error('Browser viewer disconnected');
    } catch (error) {
      // An old launch must never destroy a tab the user has since taken over.
      if (tab.ownership === ownership) {
        await tab.destroy();
        this.tabs.delete(tab.id);
        if (this.active === tab.id) this.active = previous;
      } else if (!tab.started) {
        tab.loading = false;
        tab.error = 'Opening was interrupted. Reload explicitly to recover.';
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    if (this.active && this.active !== tab.id && !this.presentations.has(this.active))
      await this.page(this.active).layout(
        this.viewport.width,
        this.viewport.height,
        this.visible,
        this.interactive,
        this.pixelRatio,
      );
    return tab;
  }
  page(id: string): RuntimeBrowserTab {
    const page = this.tabs.get(id);
    if (!page) throw new Error('Browser tab is no longer available');
    return page;
  }
  async select(id: string): Promise<void> {
    const selection = ++this.selectionRevision;
    const page = this.page(id);
    const previous = this.active;
    this.clearPicker();
    this.active = id;
    if (previous && previous !== id && !this.presentations.has(previous))
      await this.page(previous).layout(
        this.viewport.width,
        this.viewport.height,
        false,
      );
    await this.ensure(page);
    if (selection !== this.selectionRevision || !this.alive)
      throw new Error('Browser selection changed');
    if (!page.started) {
      this.revision++;
      return;
    }
    await page.themeTo(page.theme, this.colorScheme);
    if (selection !== this.selectionRevision || !this.alive)
      throw new Error('Browser selection changed');
    this.active = id;
    if (this.presentations.has(id)) { this.revision++; return; }
    await page.layout(
      this.viewport.width,
      this.viewport.height,
      this.visible,
      this.interactive,
      this.pixelRatio,
    );
    this.revision++;
  }
  async layout(
    width: number,
    height: number,
    visible: boolean,
    interactive = visible,
    pixelRatio = 1,
    colorScheme: 'light' | 'dark' = 'light',
  ): Promise<void> {
    this.touch();
    const revision = ++this.layoutRevision,
      selected = this.active;
    this.viewport = { width, height };
    this.visible = visible;
    this.interactive = interactive;
    const changedScheme = this.colorScheme !== colorScheme;
    this.colorScheme = colorScheme;
    this.pixelRatio = pixelRatio;
    const page = this.active && !this.presentations.has(this.active) ? this.page(this.active) : undefined;
    if (visible && page) {
      if (!page.started && page.url && !page.error) {
        this.launchForDisplay(page, async () => {
          if (revision === this.layoutRevision && selected === this.active)
            await this.layout(width, height, visible, interactive, pixelRatio, colorScheme);
        });
        return;
      }
      if (
        revision !== this.layoutRevision ||
        selected !== this.active ||
        !this.alive
      )
        return;
      if (changedScheme && page.theme === 'system')
        await page.themeTo('system', this.colorScheme);
    }
    if (
      revision !== this.layoutRevision ||
      selected !== this.active ||
      !this.alive
    )
      return;
    if (page?.error && !page.started) return;
    await page?.layout(width, height, visible, interactive, pixelRatio);
  }
  async command(input: TaskBrowserCommand): Promise<TaskBrowserState> {
    if (input.kind === 'agent-request-complete' || input.kind === 'agent-request-cancel' || input.kind === 'agent-request-pick') { await this.interactions.viewer(input.kind, input.requestId, input.kind === 'agent-request-pick' && input.visual === 1); return this.state(); }
    if (input.kind === 'handoff') { const request = this.interactions.pending.find(request => this.relatedTabs.members(input.tabId).includes(request.tabId)); if (request) { await this.interactions.viewer('agent-request-complete', request.id); return this.state(); } }
    this.touch();
    if (input.kind === 'move-tab') {
      const page = this.page(input.tabId);
      if (input.beforeTabId !== null) this.page(input.beforeTabId);
      if (input.beforeTabId === page.id) return this.state();
      const ordered = [...this.tabs.values()].filter(item => item !== page);
      ordered.splice(input.beforeTabId === null ? ordered.length : ordered.findIndex(item => item.id === input.beforeTabId), 0, page);
      this.tabs.clear(); for (const item of ordered) this.tabs.set(item.id, item);
    }
    else if (input.kind === 'dismiss-attention') this.attention = undefined;
    else if (input.kind === 'new-tab') {
      const page = await this.create('you', null, '', this.controller.signal);
      await this.select(page.id);
    } else if (input.kind === 'open') {
      const page = await this.create(
        'you',
        null,
        input.url,
        this.controller.signal,
      );
      await this.select(page.id);
    } else if (input.kind === 'pick') {
      const page = this.page(this.active!);
      page.takeover();
      this.clearPicker();
      this.picking = input.enabled;
      page.picking = input.enabled; page.visualPicking = input.visual === 1;
    } else if (input.kind === 'feedback') this.feedback = input.enabled;
    else {
      const page = this.page(input.tabId);
      if (input.kind === 'dialog-response') await page.workflows.respond(input.requestId, input.accept, input.text);
      else if (input.kind === 'cancel-workflow') await page.workflows.cancel(input.requestId);
      if (input.kind === 'navigate') this.authorize(input.url);
      if (input.kind === 'close' || (page.id === this.active && ['navigate', 'reload', 'back', 'forward'].includes(input.kind))) this.clearPicker();
      if (input.kind === 'select') await this.select(page.id);
      else if (input.kind === 'close') {
        if (this.attention?.tabId === page.id) this.attention = undefined;
        this.relatedTabs.remove(page.id);
        this.interactions.pageClosed(page.id);
        await page.destroy();
        this.tabs.delete(page.id); this.presentations.delete(page.id);
        if (this.active === page.id) {
          this.active = [...this.tabs.keys()].at(-1) ?? null;
          if (this.active) await this.select(this.active);
        }
      } else if (input.kind === 'handoff') {
        if (page.workflows.snapshot().length) throw new Error('Resolve site requests before handing control back');
        const authentication = this.webAuthn.snapshot();
        if (authentication && page.documentUrl && new URL(page.documentUrl).origin === authentication.origin) throw new Error('Finish authentication before handing control back');
        this.handBackGroup(page, input.sessionId);
      }
      else if (input.kind === 'takeover' || input.kind === 'focus')
        page.takeover();
      else if (input.kind === 'navigate') {
        page.takeover();
        if (!page.started && !page.error) {
          page.url = input.url;
          await this.ensure(page);
          if (this.active === page.id) await this.select(page.id);
        } else await page.navigate(input.url);
      } else if (input.kind === 'reload') {
        if (!page.url) return this.state();
        page.takeover();
        if (!page.started) {
          await page.resetEngine();
          await this.ensure(page);
          this.revision++;
          return this.state();
        }
        await page.themeTo(page.theme, this.colorScheme);
        if (page.slowNetwork) await page.networkTo(true);
        await page.reload();
      } else if (input.kind === 'back') {
        page.takeover();
        await page.back();
      } else if (input.kind === 'forward') {
        page.takeover();
        await page.forward();
      } else if (input.kind === 'width') {
        page.width = input.width;
        if (this.presentations.has(page.id)) { this.revision++; return this.state(); }
        await page.layout(
          input.width === 'phone' ? 390 : this.viewport.width,
          this.viewport.height,
          this.visible,
          this.interactive,
          this.pixelRatio,
        );
      } else if (input.kind === 'theme')
        await page.themeTo(input.theme, this.colorScheme);
      else if (input.kind === 'network') await page.networkTo(input.slow);
      else if (input.kind === 'outside')
        throw new Error('Open outside belongs to the viewing desktop');
    }
    this.revision++;
    return this.state();
  }
  async input(
    tabId: string,
    generation: number,
    input: TaskBrowserStreamInput,
  ): Promise<{ generation: number; revision: number; clipboard?: string }> {
    const page = this.page(tabId), epoch = page.inputEpoch, pointerModeEpoch = page.pointerLockEpoch;
    // Legacy clients omit lock identities. Bind their accepted request now,
    // rather than allowing queued motion to inherit a later acquisition.
    const identify = (event: TaskBrowserStreamEvent) => {
      if (event.kind !== 'pointer-relative' && event.kind !== 'pointer-unlock') return event;
      return { ...event, pointerLockEpoch: event.pointerLockEpoch ?? page.pointerLockEpoch };
    };
    input = input.kind === 'batch' ? { kind: 'batch', events: input.events.map(identify) } : identify(input);
    if (input.kind === 'pointer-unlock') {
      this.touch();
      if (!this.canInput(tabId) || !page.ready || page.generation !== generation || page.driver === 'agent')
        throw new Error('Browser control changed');
      page.revokePointerLock(input.pointerLockEpoch);
      // This receipt acknowledges revoked admission. Native exit is owned by
      // the lock tracker; a blocked input/clipboard receipt cannot hold Escape.
      return { generation: page.generation, revision: this.revision };
    }
    if (page.generation === generation && page.driver !== 'agent') {
      if (input.kind === 'release') page.revokePointerLock();
      for (const event of input.kind === 'batch' ? input.events : [input])
        if (event.kind === 'pointer-unlock') page.revokePointerLock(event.pointerLockEpoch);
    }
    let lane = this.inputLanes.get(tabId);
    if (!lane) {
      const created = new RuntimeInputLane(8, () => {
        if (this.inputLanes.get(tabId) === created) this.inputLanes.delete(tabId);
      });
      lane = created;
      this.inputLanes.set(tabId, lane);
    }
    const owner = lane;
    const motion = input.kind === 'pointer-relative'
      ? JSON.stringify([generation, epoch, input.pointerLockEpoch, input.buttons, input.modifiers]) : undefined;
    const result = owner.enqueue(() => this.deliverInput(tabId, generation, input, epoch, pointerModeEpoch), motion);
    return result;
  }
  private async deliverInput(
    tabId: string,
    generation: number,
    input: TaskBrowserStreamInput,
    epoch: number,
    pointerModeEpoch: number,
  ): Promise<{ generation: number; revision: number; clipboard?: string }> {
    this.touch();
    const page = this.page(tabId);
    if (page.inputEpoch !== epoch) throw new Error('Browser presentation changed');
    if (input.kind === 'release') {
      if (page.generation !== generation || page.driver === 'agent') throw new Error('Browser control changed');
      await page.releaseInput();
      return { generation: page.generation, revision: this.revision };
    }
    if (
      this.isPresented(tabId) &&
      this.picked &&
      input.kind === 'pointer' &&
      input.type === 'up'
    )
      return { generation: page.generation, revision: this.revision };
    if (
      !this.canInput(tabId) ||
      this.picked
    )
      throw new Error('Browser input is no longer visible');
    const events = input.kind === 'batch' ? input.events : [input];
    let expected = generation,
      result: { clipboard?: string } = {};
    for (let index = 0; index < events.length; index++) {
      const event = events[index]!;
      if (page.pointerLockEpoch !== pointerModeEpoch && (event.kind === 'wheel' || event.kind === 'pointer-exit' ||
          event.kind === 'pointer' && event.type !== 'up'))
        throw new Error('Browser pointer mode changed');
      if (
        this.picked &&
        events
          .slice(index)
          .every(
            (event) =>
              event.kind === 'pointer' &&
              (event.type === 'up' || event.type === 'move'),
          )
      )
        break;
      if (
        !this.canInput(tabId) ||
        page.inputEpoch !== epoch ||
        this.picked
      )
        throw new Error('Browser input was interrupted');
      const accepted = page.driver === 'agent' ? expected + 1 : expected;
      result = await page.userInput(expected, events[index]);
      expected = page.generation;
      if (expected !== accepted && index < events.length - 1)
        throw new Error('Browser document or control changed during input');
    }
    return { generation: page.generation, revision: this.revision, ...result };
  }
  private readonly agentTabs = new Set<string>();
  private agentPending = 0;
  async agent(
    input: BrowserAgentCommand,
    sessionId: number,
    signal: AbortSignal,
  ): Promise<BrowserAgentState> {
    if (this.agentPending >= 8) throw new Error('Browser action limit reached');
    const tab =
      input.kind === 'open' || input.kind === 'list' ? null : input.tabId;
    if (tab && this.agentTabs.has(tab))
      throw new Error('Browser tab is already processing an action');
    this.agentPending++;
    if (tab) this.agentTabs.add(tab);
    try {
      return await this.executeAgent(input, sessionId, signal);
    } finally {
      this.agentPending--;
      if (tab) this.agentTabs.delete(tab);
    }
  }
  private async executeAgent(
    input: BrowserAgentCommand,
    sessionId: number,
    signal: AbortSignal,
  ): Promise<BrowserAgentState> {
    signal.throwIfAborted();
    this.expirePresentations();
    if (!this.alive) throw new Error('Task browser is disconnected');
    if (input.kind !== 'list') {
      if (input.kind === 'open') {
        const page = await this.create('agent', sessionId, input.url, signal);
        const active = this.active ? this.page(this.active) : null;
        if (
          !active ||
          (active.driver === 'agent' && active.agentSessionId === sessionId)
        )
          await this.select(page.id);
      } else {
        const page = this.page(input.tabId);
        page.assertAgent(input.generation, sessionId);
        const ownership = page.ownership;
        const cancel = () => {
          if (page.driver === 'agent' && page.ownership === ownership)
            page.takeover();
        };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          signal.throwIfAborted();
          if (input.kind === 'click')
            await page.agentClick(
              input.x,
              input.y,
              input.generation,
              sessionId,
              input.step,
              input.n,
              input.total,
            );
          else if (input.kind === 'scroll')
            await page.agentScroll(
              input.x,
              input.y,
              input.generation,
              sessionId,
              input.atX,
              input.atY,
            );
          else if (input.kind === 'needs-user') {
            page.takeover(true);
            page.step = undefined;
          } else if (input.kind === 'select') {
            const active = this.active ? this.page(this.active) : null;
            if (
              active &&
              active !== page &&
              (active.driver !== 'agent' || active.agentSessionId !== sessionId)
            )
              throw new Error('Active tab requires explicit handoff');
            await this.select(page.id);
          } else if (input.kind === 'close') {
            if (page.by === 'you')
              throw new Error('User tabs require explicit user closure');
            await this.command({ kind: 'close', tabId: page.id });
          } else if (input.kind === 'navigate') {
            this.authorize(input.url);
            if (!page.started && !page.error) {
              page.url = input.url;
              await this.ensure(
                page,
                AbortSignal.any([signal, this.controller.signal]),
                () => page.assertAgent(input.generation, sessionId),
              );
            } else await page.navigate(input.url);
          } else if (input.kind === 'reload') await page.reload();
          else if (input.kind === 'back') await page.back();
        } finally {
          signal.removeEventListener('abort', cancel);
        }
      }
    }
    signal.throwIfAborted();
    this.revision++;
    return {
      active: this.active,
      tabs: [...this.tabs.values()].map((page) => ({
        id: page.id,
        by: page.by,
        driver: page.driver,
        agentSessionId: page.agentSessionId,
        generation: page.generation,
        loading: page.loading,
        ready: page.agentReady,
        error: page.error
          ? 'Page unavailable; ask the user to inspect it.'
          : null,
        ...(this.feedback && page.driver === 'agent'
          ? { errors: page.errors }
          : {}),
      })),
      observation: 'withheld',
      message:
        'Text, screenshots, accessibility, editable fields and raw logs are withheld for privacy. Ask the user to inspect the page or explicitly share context. Input requires the current control generation.',
    };
  }
  sweep(): void {
    if (!this.context || this.starting.size || this.disposed) return;
    void this.context
      .then((context) => {
        if (this.starting.size || this.disposed) return;
        for (const page of context.pages())
          if (!this.pool.isWindowAnchor(page) && ![...this.tabs.values()].some((tab) => tab.owns(page))) {
            void page.close({ runBeforeUnload: false }).catch(() => undefined);
            this.attention = {
              kind: 'popup',
              message:
                'An unowned popup was closed. Open the originating page outside to continue; sign-in state is separate.',
              outside: false,
            };
            this.revision++;
          }
      })
      .catch(() => undefined);
  }
  async destroy(): Promise<void> {
    if (this.disposed) return;
    this.interactions.dispose();
    this.codeEngine.dispose();
    this.disposed = true;
    this.controller.abort();
    this.listeners.clear();
    await this.webAuthn.destroy();
    this.presentations.clear();
    this.displayStarting.clear();
    for (const lane of this.inputLanes.values()) lane.destroy();
    this.inputLanes.clear();
    await Promise.allSettled(
      [...this.tabs.values()].map((page) => page.destroy()),
    );
    this.tabs.clear();
    await this.context
      ?.then((context) => context.close())
      .catch(() => undefined);
    this.network.close();
  }
}
