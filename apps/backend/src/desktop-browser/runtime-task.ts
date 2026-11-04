import type { BrowserContext } from 'playwright-core';
import { RuntimeBrowserNetwork } from './runtime-network.js';
import { browserLoopbackHost } from '@elevenex/browser-network';
import type { SavedRuntimeBrowser } from './runtime-persistence.js';
import type {
  BrowserAgentCommand,
  BrowserAgentState,
  TaskBrowserCommand,
  TaskBrowserState,
  TaskBrowserStreamInput,
} from '@elevenex/shared';
import { RuntimeBrowserTab } from './runtime-tab.js';
import type { RuntimeBrowserPool } from './runtime-browser-pool.js';
import { randomUUID } from 'node:crypto';

/** Runtime task data survives viewer reconnects; only explicit handoff can restore automation. */
export class RuntimeBrowserTask {
  readonly id = randomUUID();
  readonly tabs = new Map<string, RuntimeBrowserTab>();
  active: string | null = null;
  private readonly presentations = new Map<string, { width: number; height: number; visible: boolean; interactive: boolean; pixelRatio: number; colorScheme: 'light' | 'dark'; seen: number }>();
  isPresented(tabId: string): boolean {
    const view = this.presentations.get(tabId);
    return this.alive && (view ? view.visible && Date.now() - view.seen < 3000 : this.active === tabId && this.visible);
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
    if (visible) await this.ensure(page);
    if (this.presentations.get(tabId) !== view || !this.alive) return;
    if (page.theme === 'system') await page.themeTo('system', colorScheme);
    if (this.presentations.get(tabId) !== view || !this.alive) return;
    await page.layout(width, height, visible, interactive, pixelRatio);
  }
  private revision = 0;
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
  private controller = new AbortController();
  private connected = false;
  private readonly authorizedPorts = new Set<number>();
  private disposed = false;
  private visible = false;
  private interactive = false;
  private pixelRatio = 1;
  private colorScheme: 'light' | 'dark' = 'light';
  private viewport = { width: 800, height: 600 };
  private selectedAt = Date.now();
  private context?: Promise<BrowserContext>;
  private ownedContext?: BrowserContext;
  private layoutRevision = 0;
  private selectionRevision = 0;
  private readonly network: RuntimeBrowserNetwork;
  constructor(
    readonly taskId: number,
    private readonly pool: RuntimeBrowserPool,
    private readonly profileIdentity: string,
  ) {
    this.network = new RuntimeBrowserNetwork(
      () => this.alive,
      (port) => this.pool.isApplicationPort(port),
    );
  }
  get alive(): boolean {
    return (
      !this.disposed && this.connected && Date.now() - this.selectedAt < 10000
    );
  }
  get expired(): boolean {
    return Date.now() - this.selectedAt > 300000;
  }
  private expirePresentations(): void {
    for (const [tabId, view] of this.presentations) if (view.visible && Date.now() - view.seen >= 3000) {
      view.visible = false; view.interactive = false;
      const page = this.tabs.get(tabId); page?.takeover();
      void page?.layout(view.width, view.height, false); this.revision++;
    }
  }
  touch(): void {
    this.expirePresentations();
    this.connected = true;
    this.selectedAt = Date.now();
  }
  reconcile(): void {
    this.clearPicker();
    this.layoutRevision++;
    this.selectionRevision++;
    this.controller.abort();
    this.controller = new AbortController();
    this.connected = false;
    this.network.pause();
    this.visible = false;
    this.presentations.clear();
    for (const tab of this.tabs.values()) {
      tab.takeover();
      void tab.layout(this.viewport.width, this.viewport.height, false);
    }
    this.revision++;
  }
  setPorts(ports: readonly number[]): void {
    this.ports = ports;
  }
  state(): TaskBrowserState {
    return {
      canDetach: true,
      canReorder: true,
      layoutLanes: true,
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
      picking: this.picking,
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
      const tab = new RuntimeBrowserTab(
        item.by,
        item.agentSessionId,
        () => this.alive,
        () => this.revision++,
        (element) => {
          this.picked = element;
          this.pickerMessage = element
            ? null
            : 'Editable fields and embedded content are private. Pick another element.';
          this.picking = false;
          tab.picking = false;
          this.revision++;
        },
        this.network,
        (kind, message) => {
          this.attention = { kind, message, outside: true, tabId: tab.id };
          this.revision++;
        },
      );
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
        acceptDownloads: false,
        proxy: { server: proxy, bypass: '<-loopback>' },
        serviceWorkers: 'allow',
      });
      this.ownedContext = context;
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
      context.on('page', (popup) => {
        if (context.pages().length > 12) {
          void popup.close().catch(() => undefined);
          return;
        }
        void popup
          .opener()
          .then((opener) => {
            if (opener) {
              void popup.close().catch(() => undefined);
              const active = this.active
                ? this.tabs.get(this.active)
                : undefined;
              active?.takeover(true);
              this.revision++;
            }
          })
          .catch(() => undefined);
      });
      return context;
    })().catch((error) => {
      this.context = undefined;
      throw error;
    }));
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
  async create(
    by: 'you' | 'agent',
    sessionId: number | null,
    url: string,
    signal?: AbortSignal,
  ): Promise<RuntimeBrowserTab> {
    if (url) this.authorize(url);
    if (this.tabs.size >= 12) throw new Error('Task browser tab limit reached');
    const tab = new RuntimeBrowserTab(
      by,
      sessionId,
      () => this.alive,
      () => this.revision++,
      (element) => {
        this.picked = element;
        this.pickerMessage = element
          ? null
          : 'Editable fields and embedded content are private. Pick another element.';
        this.picking = false;
        tab.picking = false;
        this.revision++;
      },
      this.network,
      (kind, message) => {
        this.attention = { kind, message, outside: true, tabId: tab.id };
        this.revision++;
      },
    );
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
      await this.ensure(page);
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
      page.picking = input.enabled;
    } else if (input.kind === 'feedback') this.feedback = input.enabled;
    else {
      const page = this.page(input.tabId);
      if (input.kind === 'navigate') this.authorize(input.url);
      if (input.kind === 'close' || (page.id === this.active && ['navigate', 'reload', 'back'].includes(input.kind))) this.clearPicker();
      if (input.kind === 'select') await this.select(page.id);
      else if (input.kind === 'close') {
        if (this.attention?.tabId === page.id) this.attention = undefined;
        await page.destroy();
        this.tabs.delete(page.id); this.presentations.delete(page.id);
        if (this.active === page.id) {
          this.active = [...this.tabs.keys()].at(-1) ?? null;
          if (this.active) await this.select(this.active);
        }
      } else if (input.kind === 'handoff') page.handoff(input.sessionId);
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
        await page.navigate(page.url);
      } else if (input.kind === 'back') {
        page.takeover();
        await page.back();
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
    this.touch();
    const page = this.page(tabId);
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
        this.picked
      )
        throw new Error('Browser input was interrupted');
      const accepted = page.driver === 'agent' ? expected + 1 : expected;
      result = await page.userInput(expected, events[index]!);
      expected = page.generation;
      if (expected !== accepted && index < events.length - 1)
        throw new Error('Browser document or control changed during input');
    }
    this.revision++;
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
          } else if (input.kind === 'reload') await page.navigate(page.url);
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
        ready: page.ready,
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
          if (![...this.tabs.values()].some((tab) => tab.owns(page))) {
            void page.close({ runBeforeUnload: false }).catch(() => undefined);
            const active = this.active ? this.tabs.get(this.active) : undefined;
            active?.takeover(true);
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
    this.disposed = true;
    this.presentations.clear();
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
