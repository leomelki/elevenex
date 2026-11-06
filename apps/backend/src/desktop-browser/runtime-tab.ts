import type { BrowserContext, CDPSession, Page, Request } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import type {
  BrowserElement,
  TaskBrowserTab,
  TaskBrowserStreamEvent,
} from '@elevenex/shared';
import { RuntimeBrowserNetwork, runtimeUrl } from './runtime-network.js';
import { RuntimeBrowserInput } from './runtime-input.js';

import { RuntimeBrowserCapture, type RuntimeFrame, type RuntimeVideoCapture } from './runtime-capture.js';
export type { RuntimeFrame, RuntimeVideoCapture } from './runtime-capture.js';

/** A tab has one driver, one navigation generation, one frame waiter and no text observation. */
export class RuntimeBrowserTab {
  readonly id = randomUUID();
  driver: 'you' | 'agent' | 'needs';
  generation = 1;
  displayEpoch = 1;
  private humanEpoch = 0;
  get inputEpoch(): number { return this.humanEpoch; }
  ownership = 0;
  waiting = false;
  agentSessionId: number | null;
  url = '';
  documentUrl = '';
  private pageTitle?: { url: string; text: string };
  loading = false;
  error: string | null = null;
  errors = 0;
  width: 'full' | 'phone' = 'full';
  theme: 'light' | 'dark' | 'system' = 'system';
  slowNetwork = false;
  private canGoBack = false;
  private canGoForward = false;
  private historyPending = false;
  step?: TaskBrowserTab['step'];
  target?: BrowserElement;
  picking = false;
  private page?: Page;
  private context?: BrowserContext;
  private cdp?: CDPSession;
  private input?: RuntimeBrowserInput;
  private disposed = false;
  private crashed = false;
  private layoutRevision = 0;
  private viewportChanging = false;
  private viewportUpdate: Promise<void> = Promise.resolve();
  private navigation = 0;
  private loadRevision = 0;
  private visible = false;
  private interactive = false;
  private pixelRatio = 1;
  private viewport = { width: 800, height: 600 };
  private network: RuntimeBrowserNetwork;
  private documentRequest?: Request;
  private readonly capture = new RuntimeBrowserCapture(() => ({
    ...this.viewport, pixelRatio: this.pixelRatio, displayEpoch: this.displayEpoch,
    visible: this.visible && !this.disposed,
    ready: this.started && !this.loading && !this.viewportChanging && !this.disposed,
  }));
  constructor(
    readonly by: 'you' | 'agent',
    sessionId: number | null,
    private readonly active: () => boolean,
    private readonly changed: () => void,
    private readonly picked: (element: BrowserElement | null) => void,
    network: RuntimeBrowserNetwork,
    private readonly attention: (
      kind: 'popup' | 'dialog' | 'file-picker' | 'download',
      message: string,
    ) => void = () => undefined,
  ) {
    this.driver = by;
    if (by === 'agent') this.step = { n: 1, text: 'Opening page' };
    this.agentSessionId = sessionId;
    this.network = network;
  }
  takeover(needs = false): void {
    void this.input?.reset();
    this.ownership++;
    this.waiting ||= this.driver === 'agent';
    this.driver = needs ? 'needs' : 'you';
    this.generation++;
    this.target = undefined;
  }
  handoff(sessionId: number): void {
    void this.input?.reset();
    this.ownership++;
    this.agentSessionId = sessionId;
    this.driver = 'agent';
    this.waiting = false;
    this.generation++;
    this.step = { n: 1, text: 'Waiting for a browser action' };
  }
  assertAgent(generation: number, sessionId: number, requireReady = false): void {
    if (
      this.driver !== 'agent' ||
      this.generation !== generation ||
      this.agentSessionId !== sessionId ||
      (requireReady && !this.agentReady)
    )
      throw new Error('Browser control changed; wait for explicit handoff');
  }
  owns(page: Page): boolean {
    return this.page === page;
  }
  get started(): boolean {
    return !!this.page && !this.page.isClosed() && !this.crashed;
  }
  get ready(): boolean {
    return (
      this.visible &&
      this.interactive &&
      this.active() &&
      this.started &&
      !this.loading &&
      !this.viewportChanging &&
      !this.error &&
      !this.disposed
    );
  }
  get agentReady(): boolean {
    return this.active() && this.started && !this.loading && !this.viewportChanging && !this.error && !this.disposed;
  }
  async start(context: BrowserContext): Promise<void> {
    this.context = context;
    if (this.disposed) return;
    const page = await this.context.newPage();
    if (this.disposed) {
      await page.close();
      return;
    }
    this.page = page;
    this.crashed = false;
    this.cdp = await this.context.newCDPSession(page);
    this.input = new RuntimeBrowserInput(page, this.cdp);
    this.capture.attach(this.cdp);
    // Companion views must not steal document focus from one another on layout heartbeats.
    await this.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    // Headless Chromium target metadata does not report document.title changes.
    // This page-owned binding accepts only bounded human-facing title data.
    const bindingName = '__elevenexPageTitle';
    await page.exposeBinding(bindingName, ({ frame }, url: unknown, title: unknown) => {
      if (this.disposed || this.page !== page || frame !== page.mainFrame() || url !== page.url() || typeof title !== 'string' || title.length > 200) return;
      this.pageTitle = { url: page.url(), text: title.replace(/\s+/gu, ' ').trim() };
      this.changed();
    });
    await page.addInitScript((name: string) => {
      if (window !== window.top) return;
      document.addEventListener('DOMContentLoaded', () => {
        let previous: string | undefined;
        const publish = () => {
          const title = document.title.replace(/\s+/gu, ' ').trim().slice(0, 200);
          if (title === previous) return;
          previous = title;
          const send: unknown = Reflect.get(globalThis, name);
          if (typeof send === 'function') {
            const result: unknown = Reflect.apply(send, globalThis, [location.href, title]);
            void Promise.resolve(result).catch(() => undefined);
          }
        };
        // The observers and binding die with their owning document/page.
        const head = new MutationObserver(publish);
        const observeHead = () => {
          head.disconnect();
          head.observe(document.head ?? document.documentElement, { childList: true, subtree: true, characterData: true });
          publish();
        };
        new MutationObserver(observeHead).observe(document.documentElement, { childList: true });
        observeHead();
      }, { once: true });
    }, bindingName);
    page.on('console', (message) => {
      if (message.type() === 'error') this.countError();
    });
    page.on('request', request => {
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
      this.documentRequest = request;
      this.loading = true;
      this.error = null;
      this.invalidateDisplay();
    });
    page.on('domcontentloaded', () => {
      if (this.page !== page || this.disposed) return;
      this.documentRequest = undefined;
      this.loading = false;
      void this.capture.start();
      this.changed();
    });
    page.on('requestfailed', request => {
      this.countError();
      if (request === this.documentRequest) {
        this.documentRequest = undefined;
        this.loading = false;
        this.error = 'This page could not load. Check the address or task server, then retry.';
        this.changed();
      }
    });
    page.on('response', (response) => {
      if (response.status() >= 400) this.countError();
    });
    page.on('filechooser', (chooser) => {
      this.takeover(true);
      this.attention(
        'file-picker',
        'File selection is unavailable in streamed display. Continue this workflow outside.',
      );
      void chooser
        .element()
        .dispose()
        .catch(() => undefined);
      this.changed();
    });
    page.on('download', (download) => {
      void download.cancel().catch(() => undefined);
      this.takeover(true);
      this.attention(
        'download',
        'Downloads are unavailable in streamed display. Continue this workflow outside.',
      );
      this.changed();
    });
    page.on('dialog', (dialog) => {
      void dialog.dismiss().catch(() => undefined);
      this.attention(
        'dialog',
        'This site requested a browser dialog. Continue this workflow outside; sign-in state is separate.',
      );
      this.takeover(true);
      this.changed();
    });
    page.on('crash', () => {
      this.crashed = true;
      this.takeover(true);
      this.loading = false;
      this.error = 'The page stopped. Reload to recover with user control.';
      this.changed();
    });
    page.on('close', () => {
      if (this.disposed || this.page !== page) return;
      this.crashed = true;
      this.takeover(true);
      this.loading = false;
      this.error =
        'The browser disconnected. Reload to reopen with user control.';
      this.capture.invalidate();
      this.changed();
    });
    page.on('framenavigated', (frame) => {
      if (this.page !== page) return;
      if (frame === page.mainFrame()) {
        void this.input?.reset();
        this.navigation++;
        this.generation++;
        this.invalidateDisplay();
        try {
          this.url = runtimeUrl(frame.url()).href;
          this.documentUrl = this.url;
        } catch {
          /* Initial blank page. */
        }
        // Same-document navigation may keep the title without mutating <head>.
        const previousTitle = this.pageTitle, navigation = this.navigation;
        if (previousTitle && previousTitle.url !== this.url) {
          void page.title().then(title => {
            if (this.disposed || this.page !== page || this.navigation !== navigation || this.pageTitle !== previousTitle) return;
            this.pageTitle = { url: this.url, text: title.replace(/\s+/gu, ' ').trim().slice(0, 200) };
            this.changed();
          }).catch(() => undefined);
        }
        this.target = undefined;
        void this.history();
        this.changed();
      }
    });
  }

  private async history(): Promise<void> {
    if (this.historyPending || !this.cdp) return;
    this.historyPending = true;
    const cdp = this.cdp,
      navigation = this.navigation;
    try {
      const history = await this.cdp.send('Page.getNavigationHistory');
      if (this.cdp !== cdp || this.navigation !== navigation) return;
      this.canGoBack = history.currentIndex > 0;
      this.canGoForward = history.currentIndex < history.entries.length - 1;
      if (history.entries.length > 100) {
        await this.cdp.send('Page.resetNavigationHistory');
        this.canGoBack = false;
        this.canGoForward = false;
      }
      this.changed();
    } catch {
      /* Closed page. */
    } finally {
      this.historyPending = false;
    }
  }
  private countError(): void {
    if (this.active() && this.errors < 999) {
      this.errors++;
      this.changed();
    }
  }
  setPorts(ports: readonly number[]): void {
    this.network.setPorts(ports);
  }
  snapshot(): TaskBrowserTab {
    let title = 'New tab';
    try {
      const url = new URL(this.url);
      title = url.pathname === '/' ? url.host : url.pathname.slice(0, 160);
    } catch {
      /* New tab. */
    }
    // Human presentation only; the automation reply has its own allowlist.
    if (this.pageTitle?.url === this.url && this.url === this.documentUrl && this.pageTitle.text) title = this.pageTitle.text;
    return {
      id: this.id,
      title,
      url: this.url,
      by: this.by,
      driver: this.driver,
      agentSessionId: this.agentSessionId,
      generation: this.generation,
      displayEpoch: this.displayEpoch,
      loading: this.loading,
      ready: this.ready,
      canGoBack: this.canGoBack,
      canGoForward: this.canGoForward,
      error: this.error,
      errors: this.errors,
      width: this.width,
      theme: this.theme,
      slowNetwork: this.slowNetwork,
      waiting: this.waiting,
      step: this.step,
      target: this.target,
    };
  }
  async navigate(address: string): Promise<void> {
    const url = runtimeUrl(address);
    this.network.authorize(url);
    this.url = url.href;
    await this.load((page) => page.goto(url.href, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    }));
  }
  /** Only the latest navigation on this engine may publish completion or failure. */
  private async load(operation: (page: Page) => Promise<unknown>): Promise<void> {
    const page = this.page;
    if (!page || !this.started || this.disposed) throw new Error('Browser page is unavailable');
    const revision = ++this.loadRevision;
    const current = () => !this.disposed && this.page === page && revision === this.loadRevision;
    this.pageTitle = undefined;
    this.loading = true;
    this.error = null;
    this.invalidateDisplay();
    try {
      await operation(page);
    } catch {
      if (current()) this.error =
        'This page could not load. Check the address or task server, then retry.';
    } finally {
      if (current()) {
        this.loading = false;
        void this.capture.start();
        this.changed();
      }
    }
  }
  async layout(
    width: number,
    height: number,
    visible: boolean,
    interactive = visible,
    pixelRatio = 1,
  ): Promise<void> {
    const revision = ++this.layoutRevision;
    const current = () => revision === this.layoutRevision && !this.disposed;
    const changed =
      this.visible !== visible || this.interactive !== interactive;
    if (changed) this.humanEpoch++;
    this.visible = visible;
    this.interactive = interactive;
    if (changed) this.changed();
    if (visible && !interactive) {
      await this.input?.reset();
      if (!current()) return;
    }
    if (!visible) {
      await this.input?.reset();
      if (!current()) return;
      this.capture.invalidate();
      await this.capture.stop();
      return;
    }
    // Apply complete viewport operations in order. A newer heartbeat may replace
    // intent, but cannot abandon a half-applied Chromium size/DPR update.
    await this.viewportUpdate;
    if (!current()) return;
    const viewport = {
      width: Math.max(100, Math.min(2560, Math.round(width))),
      height: Math.max(100, Math.min(1600, Math.round(height))),
    };
    if (viewport.width !== this.viewport.width || viewport.height !== this.viewport.height || pixelRatio !== this.pixelRatio) {
      const operation = this.resizeViewport(viewport, pixelRatio, current);
      this.viewportUpdate = operation.catch(() => undefined);
      await operation;
      if (!current()) return;
    }
    await this.capture.start();
  }
  private async resizeViewport(viewport: { width: number; height: number }, pixelRatio: number, current: () => boolean): Promise<void> {
    const page = this.page, cdp = this.cdp;
    const engineCurrent = () => !this.disposed && this.page === page && this.cdp === cdp;
    this.viewportChanging = true;
    try {
      await this.input?.reset();
      if (!current()) return;
      const resized = viewport.width !== this.viewport.width || viewport.height !== this.viewport.height;
      if (resized) {
        if (viewport.width !== this.viewport.width) this.takeover();
        else this.generation++;
      }
      // Publish the new generation with its epoch, before any asynchronous CDP
      // work. Otherwise viewers can keep the old generation indefinitely.
      this.invalidateDisplay();
      await this.capture.stop();
      if (!current()) return;
      if (resized) await page?.setViewportSize(viewport);
      if (!engineCurrent()) return;
      await cdp?.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width, height: viewport.height,
        deviceScaleFactor: pixelRatio, mobile: false,
      });
      if (!engineCurrent()) return;
      this.viewport = viewport;
      this.pixelRatio = pixelRatio;
    } finally {
      this.viewportChanging = false;
      this.changed();
    }
  }
  private invalidateDisplay(): void {
    this.displayEpoch++;
    this.humanEpoch++;
    void this.input?.reset();
    this.capture.invalidate();
    this.changed();
  }
  nextFrame(after: number, signal: AbortSignal, waitMs = 5000, video: boolean | RuntimeVideoCapture = false): Promise<RuntimeFrame | null> {
    return this.capture.next(after, signal, waitMs, video);
  }
  async userInput(
    generation: number,
    input: TaskBrowserStreamEvent,
  ): Promise<{ clipboard?: string }> {
    const previousGeneration = this.generation;
    // A stale human display still stops automation. It cannot authorize input
    // at outdated coordinates, so that event fails and fresh state is required.
    if (this.driver === 'agent') {
      this.takeover();
      this.changed();
    }
    if (!this.ready || generation !== previousGeneration)
      throw new Error('Browser control changed');
    if (
      (input.kind === 'pointer' || input.kind === 'wheel') &&
      (input.x >= this.viewport.width || input.y >= this.viewport.height)
    )
      throw new Error('Input is outside the viewport');
    const acceptedGeneration = this.generation,
      navigation = this.navigation,
      inputEpoch = this.inputEpoch;
    const current = () => {
      if (
        !this.ready ||
        this.generation !== acceptedGeneration ||
        this.inputEpoch !== inputEpoch ||
        this.navigation !== navigation
      )
        throw new Error('Browser input was interrupted');
    };
    if (this.picking) {
      if (input.kind === 'pointer' && input.type === 'down') {
        const element = await this.inspect(input.x, input.y);
        current();
        if (this.picking) this.picked(element);
      }
      return {};
    }
    const result = await this.input!.dispatch(input, current);
    this.capture.changed();
    return result;
  }
  releaseInput(): Promise<void> {
    return this.input?.reset() ?? Promise.resolve();
  }
  async inspect(x: number, y: number): Promise<BrowserElement | null> {
    return this.page!.evaluate(
      ({ x, y }) => {
        const node = document.elementFromPoint(x, y);
        if (
          !node ||
          node.closest(
            'input,textarea,select,iframe,object,embed,[contenteditable]',
          ) ||
          node.shadowRoot
        )
          return null;
        const known = new Set(
          'a article aside b body button code div em footer form h1 h2 h3 header hr html i img label li main nav ol p pre section small span strong table tbody td th tr ul'.split(
            ' ',
          ),
        );
        const parts: string[] = [];
        let el: Element | null = node;
        while (el && el !== document.documentElement && parts.length < 20) {
          parts.unshift(
            (known.has(el.localName) ? el.localName : '*') +
              ':nth-child(' +
              (Array.prototype.indexOf.call(
                el.parentElement?.children || [],
                el,
              ) +
                1) +
              ')',
          );
          el = el.parentElement;
        }
        if (el !== document.documentElement) return null;
        const r = node.getBoundingClientRect();
        return {
          selector: 'html > ' + parts.join(' > '),
          tag: known.has(node.localName) ? node.localName : 'element',
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        };
      },
      { x, y },
    );
  }
  async agentClick(
    x: number,
    y: number,
    generation: number,
    sessionId: number,
    step: string,
    n = 1,
    total?: number,
  ): Promise<void> {
    this.assertAgent(generation, sessionId, true);
    await this.input?.settled();
    this.assertAgent(generation, sessionId, true);
    const target = await this.inspect(x, y);
    this.assertAgent(generation, sessionId, true);
    if (!target || target.tag === 'element') {
      this.takeover(true);
      throw new Error('Private or embedded control requires the user');
    }
    this.target = target;
    this.step = { n, text: step, ...(total === undefined ? {} : { total }) };
    const down = this.cdp!.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    const up = this.cdp!.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await Promise.all([down, up]);
    this.changed();
  }
  async agentScroll(
    x: number,
    y: number,
    generation: number,
    sessionId: number,
    atX = this.viewport.width / 2,
    atY = this.viewport.height / 2,
  ): Promise<void> {
    this.assertAgent(generation, sessionId, true);
    await this.input?.settled();
    this.assertAgent(generation, sessionId, true);
    await this.page!.mouse.move(atX, atY);
    this.assertAgent(generation, sessionId, true);
    await this.page!.mouse.wheel(x, y);
  }
  async themeTo(
    theme: 'system' | 'light' | 'dark',
    system: 'light' | 'dark' = 'light',
  ): Promise<void> {
    if (this.started) await this.page!.emulateMedia({
      colorScheme: theme === 'system' ? system : theme,
    });
    this.theme = theme;
  }
  async networkTo(slow: boolean): Promise<void> {
    if (!this.started) { this.slowNetwork = slow; return; }
    // Network emulation is a no-op on this CDP session until its domain is
    // enabled. The private session does not retain bodies or posted data.
    await this.cdp!.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 });
    await this.cdp!.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: slow ? 150 : 0,
      downloadThroughput: slow ? 200000 : -1,
      uploadThroughput: slow ? 90000 : -1,
    });
    this.slowNetwork = slow;
  }
  async back(): Promise<void> {
    await this.load((page) => page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }));
  }
  async reload(): Promise<void> {
    await this.load(page => page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }));
  }
  async forward(): Promise<void> {
    await this.load((page) => page.goForward({ waitUntil: 'domcontentloaded', timeout: 20000 }));
  }
  async destroy(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.takeover();
    this.capture.detach();
    await this.capture.stop();
    await this.page?.close({ runBeforeUnload: false });
    await this.viewportUpdate;
    this.page = undefined;
  }
  /** Explicit human recovery; no navigation or queued action is resumed here. */
  async resetEngine(): Promise<void> {
    this.invalidateDisplay();
    const page = this.page,
      cdp = this.cdp;
    this.page = undefined;
    this.cdp = undefined;
    this.layoutRevision++;
    this.visible = false;
    this.interactive = false;
    this.pixelRatio = 1;
    this.viewport = { width: 0, height: 0 };
    this.capture.detach();
    this.crashed = false;
    this.canGoBack = false;
    this.canGoForward = false;
    this.error = null;
    this.loading = true;
    this.takeover();
    await this.input?.reset();
    this.input = undefined;
    await cdp?.detach().catch(() => undefined);
    await page?.close({ runBeforeUnload: false }).catch(() => undefined);
    await this.viewportUpdate;
  }
}
