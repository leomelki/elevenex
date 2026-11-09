import { browserHoverAt, BrowserPickerHover, resolvePickedBrowserSources, pickBrowserElement } from '@elevenex/browser-agent';
import { BrowserAgentPresentation } from '@elevenex/browser-agent';
import { RuntimeBrowserWorkflows, RuntimeWorkflowBudget } from './runtime-workflows.js';
import { PROTOCOL_EVENTS, NestedSessions, ProtocolLease, AgentInputState, type BrowserAgentTarget, type BrowserAgentDownload } from '@elevenex/browser-agent';
import type { TaskBrowserCursor } from '@elevenex/shared';
import type { BrowserContext, CDPSession, Page, Request } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import type {
  BrowserElement,
  TaskBrowserTab,
  TaskBrowserStreamEvent,
} from '@elevenex/shared';
import { RuntimeBrowserNetwork, runtimeUrl } from './runtime-network.js';
import { RuntimeBrowserInput } from './runtime-input.js';
import { RuntimeBrowserCursor } from './runtime-cursor.js';
import { RuntimePointerLock } from './runtime-pointer-lock.js';
import { detectBrowserSources } from '@elevenex/browser-inspection';

import { RuntimeBrowserCapture, type RuntimeFrame, type RuntimeVideoCapture } from './runtime-capture.js';
export type { RuntimeFrame, RuntimeVideoCapture } from './runtime-capture.js';

/** A tab has one driver, one navigation generation, one frame waiter and no text observation. */
export class RuntimeBrowserTab {
  private readonly presentationFeedback = new BrowserAgentPresentation(() => this.changed());
  agentPicker?: (x: number, y: number) => Promise<void>;
  agentSelectionPaused = false;
  private readonly documentScope = randomUUID();
  get documentId(): string { return this.documentScope + ':' + this.navigation; }
  private playwrightConnections = 0;
  private readonly agentDownloads = new Set<(download: BrowserAgentDownload) => void>();
  get agentPlaywright(): boolean { return this.driver === 'agent' && this.playwrightConnections > 0; }
  private readonly agentInputs = new Set<AgentInputState>();
  /** Main-only page capability. Ownership survives navigation, never a takeover. */
  async agentTarget(
    sessionId: number,
    active: () => boolean,
    goto: BrowserAgentTarget['goto'],
    close: () => Promise<void>,
    authorize?: BrowserAgentTarget['authorize'],
    watch?: (listener: () => void) => () => void,
    human?: () => boolean,
  ): Promise<BrowserAgentTarget> {
    const ownership = this.ownership;
    const assert = () => {
      if (
        !active() ||
        this.disposed ||
        !this.started ||
        (!human &&
          (this.driver !== 'agent' || this.agentSessionId !== sessionId)) ||
        (human && (!human() || this.driver === 'agent')) ||
        this.ownership !== ownership ||
        !this.cdp
      )
        throw new Error(
          'Tab control changed. Acquire a fresh handle; a user stop requires Hand back.',
        );
    };
    assert();
    const cdp = await this.context!.newCDPSession(this.page!);
    try {
      assert();
      const send = (method: string, params: Record<string, unknown>) =>
        cdp.send(method as Parameters<CDPSession['send']>[0], params);
      let playing = false,
        closed = false;
      const nested = new NestedSessions(send);
      const input = new AgentInputState(send);
      const lease = new ProtocolLease(
        (method, params, child) => {
          // Screenshot clipping temporarily changes device emulation. Run human
          // captures on its owning session so Chromium restores the stream's
          // pixel density, rather than this temporary inspection session's 1x.
          if (human && !child && method === 'Page.captureScreenshot') {
            if (!this.cdp) throw new Error('Browser presentation changed');
            return this.cdp.send('Page.captureScreenshot', params);
          }
          return nested.send(method, params, child);
        },
        async () => {
          await cdp.detach();
        },
      );
      const events = PROTOCOL_EVENTS.map((method) => {
        const receive = (params: unknown) =>
          nested.receive(method, params, (method, params, child) =>
            lease.receive(method, params, child),
          );
        cdp.on(method, receive);
        return () => cdp.off(method, receive);
      });
      this.agentInputs.add(input);
      return {
        id: this.id,
        assert,
        // The shared broker validates protocol names and parameters at runtime.
        send: async (method, params, child) => {
          assert();
          const generation = this.generation;
          input.record(method, params);
          const result = await lease.send(method, params, child);
          assert(); if (!human && generation === this.generation) { if (method === 'Input.dispatchMouseEvent') this.target = undefined; this.presentationFeedback.input(method, params); }
          return result;
        },
        present: (command, documentId, generation) => {
          assert();
          if (human || (command.kind === 'cursor' && documentId !== this.documentId)) throw new Error('Browser feedback document changed');
          // A viewport-only race discards decoration, never delays/replays input.
          if (command.kind === 'cursor' && generation !== this.generation) return;
          this.target = undefined;
          this.presentationFeedback.update(command);
        },
        subscribe: (listener) => {
          const stopEvents = lease.subscribe(listener);
          const stop = watch?.(() => {
            try {
              assert();
            } catch {
              listener('Elevenex.controlRevoked', {});
            }
          });
          return () => {
            stop?.();
            stopEvents();
          };
        },
        authorize,
        subscribeDownloads: (listener) => {
          this.agentDownloads.add(listener);
          return () => this.agentDownloads.delete(listener);
        },
        playwright: () => {
          if (!playing) {
            playing = true;
            this.playwrightConnections++;
          }
        },
        dispose: async () => {
          if (closed) return;
          closed = true;
          if (playing && --this.playwrightConnections === 0 && this.driver === 'agent') this.presentationFeedback.interrupt();
          input.release();
          await lease.dispose();
          for (const stop of events) stop();
          nested.dispose();
          this.agentInputs.delete(input);
        },
        goto: async (url, signal) => {
          assert();
          await goto(url, signal);
          assert();
        },
        close: async () => {
          assert();
          if (this.by !== 'agent')
            throw new Error('User-created tabs require user closure');
          await close();
        },
        interrupt: () => {
          assert();
          input.release();
          void cdp.send('Runtime.terminateExecution').catch(() => undefined);
          void cdp.send('Page.stopLoading').catch(() => undefined);
          void this.input?.reset();
        },
      };
    } catch (error) {
      await cdp.detach().catch(() => undefined);
      throw error;
    }
  }
  readonly id = randomUUID();
  readonly workflows: RuntimeBrowserWorkflows;
  private cursor: TaskBrowserCursor = 'default';
  private readonly pointerLock = new RuntimePointerLock(() => {
    this.input?.pointerLockChanged();
    this.changed();
  }, () => this.ready && this.driver !== 'agent');
  get pointerLockEpoch(): number { return this.pointerLock.epoch; }
  revokePointerLock(epoch?: number): void { this.pointerLock.unlock(epoch); }
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
  private pickerEpoch = 0;
  private pickerCancellation = new AbortController();
  private pickerEnabled = false;
  get picking(): boolean { return this.pickerEnabled; }
  set picking(enabled: boolean) {
    this.pickerCancellation.abort(); this.pickerCancellation = new AbortController();
    this.pickerEpoch++; this.pickerEnabled = enabled; this.pickerHover.reset();
  }
  private readonly pickerHover = new BrowserPickerHover(
    (x, y, signal) => browserHoverAt((method, params) => {
      if (!this.cdp) throw new Error('Page unavailable');
      // The shared human-only reader issues one fixed structural expression.
      return this.cdp.send(method as Parameters<CDPSession['send']>[0], params);
    }, x, y, signal),
    () => this.changed(),
  );
  visualPicking = false;
  private capturingEpoch?: number;
  get capturePending(): boolean { return this.capturingEpoch === this.pickerEpoch; }
  private page?: Page;
  private context?: BrowserContext;
  private cdp?: CDPSession;
  private stopNavigation?: () => void;
  private input?: RuntimeBrowserInput;
  private cursorReader?: RuntimeBrowserCursor;
  private disposed = false;
  private crashed = false;
  private layoutRevision = 0;
  private viewportChanging = false;
  private viewportUpdate: Promise<void> = Promise.resolve();
  private navigation = 0;
  private loadRevision = 0;
  private visible = false;
  get selectionViewportId(): string { return this.displayEpoch + ":" + this.visible; }
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
    workflowBudget = new RuntimeWorkflowBudget(),
    private readonly controlChanged: () => void = () => undefined,
  ) {
    this.workflows = new RuntimeBrowserWorkflows(() => this.changed(), () => this.takeover(true), workflowBudget, message => this.attention('download', message));
    this.driver = by;
    if (by === 'agent') this.step = { n: 1, text: 'Opening page' };
    this.agentSessionId = sessionId;
    this.network = network;
  }
  agentPaused = false;
  stopAgent(): void { this.agentPaused = true; this.waiting = true; this.takeover(); }
  takeover(needs = false, pauseAgent = true): void {
    this.presentationFeedback.clear();
    this.agentPaused ||= pauseAgent && (this.driver === 'agent' || needs);
    for (const input of this.agentInputs) input.release();
    void this.input?.reset();
    void this.input?.unlockPointer();
    this.ownership++;
    this.waiting ||= this.driver === 'agent';
    this.driver = needs ? 'needs' : 'you';
    this.generation++;
    this.target = undefined;
    this.controlChanged();
  }
  handoff(sessionId: number): void {
    this.presentationFeedback.clear();
    this.agentPaused = false;
    for (const input of this.agentInputs) input.release();
    void this.input?.reset();
    void this.input?.unlockPointer();
    this.ownership++;
    this.agentSessionId = sessionId;
    this.driver = 'agent';
    this.waiting = false;
    this.generation++;
    this.step = { n: 1, text: 'Waiting for a browser action' };
    this.controlChanged();
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
  async start(context: BrowserContext, adopted?: Page): Promise<void> {
    this.context = context;
    if (this.disposed) return;
    const page = adopted ?? await this.context.newPage();
    if (this.disposed) {
      await page.close();
      return;
    }
    this.page = page;
    this.crashed = false;
    page.on('dialog', dialog => { if (!this.agentPlaywright) this.workflows.dialog(dialog); });
    page.on('filechooser', chooser => { if (!this.agentPlaywright) this.workflows.upload(chooser); });
    page.on('download', download => {
      // A download navigation keeps the existing document. It is not a failed
      // replacement page, and must not leave input/capture stuck loading.
      this.loadRevision++; this.documentRequest = undefined;
      this.loading = false; this.error = null; this.url = this.documentUrl;
      if (this.agentPlaywright) { for (const listener of this.agentDownloads) listener({ url: download.url(), filename: download.suggestedFilename(), path: () => download.path(), cancel: () => download.cancel(), dispose: () => download.delete() }); }
      else this.workflows.download(download);
      void this.capture.start(); this.changed();
    });
    this.cdp = await this.context.newCDPSession(page);
    this.input = new RuntimeBrowserInput(page, this.cdp, this.pointerLock);
    this.cursorReader = new RuntimeBrowserCursor(page, cursor => {
      if (cursor === this.cursor) return;
      this.cursor = cursor;
      this.changed();
    });
    this.capture.attach(this.cdp);
    await this.pointerLock.attach(page, this.cdp);
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
    page.on('crash', () => {
      void this.workflows.clear();
      this.crashed = true;
      this.takeover(true);
      this.loading = false;
      this.error = 'The page stopped. Reload to recover with user control.';
      this.changed();
    });
    page.on('close', () => {
      if (this.disposed || this.page !== page) return;
      void this.workflows.clear();
      this.crashed = true;
      this.takeover(true);
      this.loading = false;
      this.error =
        'The browser disconnected. Reload to reopen with user control.';
      this.capture.invalidate();
      this.changed();
    });
    await this.watchNavigation(page, this.cdp);
    if (adopted) {
      try { this.url = runtimeUrl(page.url()).href; this.documentUrl = this.url; } catch { /* about:blank popup */ }
      this.loading = false;
      this.pageTitle = { url: this.url, text: (await page.title()).replace(/\s+/gu, ' ').trim().slice(0, 200) };
      await this.history();
      this.changed();
    }
  }

  private async watchNavigation(page: Page, cdp: CDPSession): Promise<void> {
    const { frameTree } = await cdp.send('Page.getFrameTree');
    if (this.disposed || this.page !== page || this.cdp !== cdp) return;
    let mainFrameId = frameTree.frame.id;
    const documentChanged = ({ frame }: { frame: { id: string; parentId?: string; url: string; urlFragment?: string } }) => {
      if (frame.parentId) return;
      mainFrameId = frame.id;
      this.navigated(page, frame.url + (frame.urlFragment ?? ''), false);
    };
    const withinDocument = ({ frameId, url }: { frameId: string; url: string }) => {
      if (frameId === mainFrameId) this.navigated(page, url, true);
    };
    // New documents and explicit document.open invalidate human coordinates.
    // SPA panels often route before data arrives and retain their document.
    cdp.on('Page.frameNavigated', documentChanged);
    cdp.on('Page.documentOpened', documentChanged);
    cdp.on('Page.navigatedWithinDocument', withinDocument);
    this.stopNavigation = () => {
      cdp.off('Page.frameNavigated', documentChanged);
      cdp.off('Page.documentOpened', documentChanged);
      cdp.off('Page.navigatedWithinDocument', withinDocument);
    };
    await cdp.send('Page.enable');
  }
  private navigated(page: Page, address: string, sameDocument: boolean): void {
    if (this.disposed || this.page !== page) return;
    this.presentationFeedback.clearPointer();
    if (!sameDocument) {
      void this.workflows.documentChanged();
      this.cursor = 'default';
      this.navigation++;
      this.generation++;
      this.invalidateDisplay();
    } else {
      // Route changes still invalidate agent observations and pending actions.
      // Human gestures and held state belong to the surviving document.
      if (this.driver === 'agent') { this.navigation++; this.generation++; }
      this.capture.changed();
    }
    try {
      this.url = runtimeUrl(address).href;
      this.documentUrl = this.url;
    } catch {
      /* Initial blank page. */
    }
    const previousTitle = this.pageTitle, navigation = this.navigation, url = this.url;
    if (sameDocument && previousTitle) {
      this.pageTitle = { url, text: previousTitle.text };
    } else if (previousTitle && previousTitle.url !== url) {
      void page.title().then(title => {
        if (this.disposed || this.page !== page || this.navigation !== navigation || this.url !== url || this.pageTitle !== previousTitle) return;
        this.pageTitle = { url, text: title.replace(/\s+/gu, ' ').trim().slice(0, 200) };
        this.changed();
      }).catch(() => undefined);
    }
    this.target = undefined;
    void this.history();
    this.changed();
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
      workflows: this.workflows.snapshot(),
      cursor: this.cursor,
      pointerLocked: this.pointerLock.locked,
      pointerLockEpoch: this.pointerLock.epoch,
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
      step: this.presentationFeedback.step ?? this.step,
      ...(this.presentationFeedback.cursor ? { agentCursor: this.presentationFeedback.cursor } : {}),
      ...(this.presentationFeedback.highlight ? { agentHighlight: this.presentationFeedback.highlight } : {}),
      target: this.target,
      ...(this.picking && this.ready && this.pickerHover.value ? { hovered: this.pickerHover.value } : {}),
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
    if (changed) { this.pickerHover.reset(); this.humanEpoch++; }
    this.visible = visible;
    this.interactive = interactive;
    if (changed) this.changed();
    if (!visible || !interactive) {
      await this.input?.unlockPointer();
    }
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
        this.presentationFeedback.clearPointer();
        if (viewport.width !== this.viewport.width) this.takeover(false, false);
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
        screenWidth: viewport.width, screenHeight: viewport.height,
      });
      if (!engineCurrent()) return;
      // Persistent headless Chrome can size its backing view minus native
      // chrome insets while reporting the requested innerHeight. Screencast
      // metadata then disagrees with input coordinates. Set both explicitly.
      const browserWindow = await cdp?.send('Browser.getWindowForTarget');
      if (!engineCurrent()) return;
      if (browserWindow) await cdp?.send('Browser.setContentsSize', { windowId: browserWindow.windowId, ...viewport });
      if (!engineCurrent()) return;
      this.viewport = viewport;
      this.pixelRatio = pixelRatio;
    } finally {
      this.viewportChanging = false;
      this.changed();
    }
  }
  private invalidateDisplay(): void {
    this.pickerHover.reset();
    this.cursorReader?.reset();
    void this.input?.unlockPointer();
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
    if (this.agentSelectionPaused) return {};
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
      inputEpoch = this.inputEpoch, picker = this.pickerEpoch;
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
      if (this.capturePending) return {};
      const valid = () => { try { current(); return this.picking && !this.capturePending && !this.disposed; } catch { return false; } };
      if (input.kind === 'pointer-exit' || input.kind === 'release') this.pickerHover.reset();
      if (input.kind === 'pointer' && input.type === 'move') { this.pickerHover.update(input.x, input.y, valid); return {}; }
      if (input.kind === 'wheel') this.pickerHover.update(input.x, input.y, valid);
      if (input.kind === 'pointer' && input.type === 'down' && input.button === 'left') {
        this.pickerHover.pause();
        if (this.agentPicker) { await this.agentPicker(input.x, input.y); return {}; }
        if (!this.visualPicking) {
          const element = await this.inspect(input.x, input.y, () => { try { current(); return this.picking && picker === this.pickerEpoch && !this.disposed; } catch { return false; } });
          current(); if (this.picking) this.picked(element);
          return {};
        }
        if (this.capturePending) return {};
        this.capturingEpoch = this.pickerEpoch; this.changed();
        try {
          const valid = () => { try { current(); return this.picking && picker === this.pickerEpoch && !this.disposed; } catch { return false; } };
          const target = await this.agentTarget(1, valid, () => Promise.reject(new Error('Inspection cannot navigate')), () => Promise.reject(new Error('Inspection cannot close')), undefined, () => () => undefined, valid);
          let element = await pickBrowserElement(target, input.x, input.y, this.documentId, valid, '140.0.0.0', true, this.pickerCancellation.signal);
          if (!element.snapshot?.jpeg) throw new Error('Element snapshot unavailable');
          element = await resolvePickedBrowserSources(element, live => this.inspect(input.x, input.y, live), valid);
          current();
          if (valid()) this.picked(element);
        } catch { if (this.picking && picker === this.pickerEpoch && !this.disposed) this.picked(null); }
        finally { if (this.capturingEpoch === picker) this.capturingEpoch = undefined; this.changed(); }
      }
      if (!(input.kind === 'wheel' || input.kind === 'pointer-exit' || input.kind === 'pointer' && input.type === 'move')) return {};
    }
    const result = await this.input!.dispatch(input, current);
    this.capture.changed();
    if (input.kind === 'pointer' || input.kind === 'pointer-exit') {
      const x = input.kind === 'pointer' ? input.x : -1, y = input.kind === 'pointer' ? input.y : -1;
      this.cursorReader?.update(x, y, () =>
        this.ready && this.generation === acceptedGeneration &&
        this.inputEpoch === inputEpoch && this.navigation === navigation,
      );
    }
    return result;
  }
  async releaseInput(): Promise<void> {
    await this.input?.reset(); await this.input?.unlockPointer();
  }
  async inspect(x: number, y: number, sourceCurrent?: () => boolean): Promise<BrowserElement | null> {
    const pageUrl = this.documentUrl;
    const element = await this.page!.evaluate(
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
    if (!element || !sourceCurrent) return element;
    const current = () => !this.disposed && this.documentUrl === pageUrl && sourceCurrent();
    const sources = await detectBrowserSources(async expression => {
      if (!current() || !this.cdp) return undefined;
      const reply = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 900 });
      return reply.result.value;
    }, element.selector, pageUrl, current);
    return current() ? { ...element, ...sources } : element;
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
    this.presentationFeedback.dispose();
    this.disposed = true;
    this.pickerCancellation.abort();
    this.pickerHover.destroy();
    this.cursorReader?.destroy();
    this.cursorReader = undefined;
    this.stopNavigation?.(); this.stopNavigation = undefined;
    await this.workflows.destroy();
    this.takeover();
    const pointerCleanup = this.pointerLock.detach();
    this.capture.detach();
    const captureCleanup = this.capture.stop();
    this.input?.destroy();
    await this.page?.close({ runBeforeUnload: false });
    await Promise.all([pointerCleanup, captureCleanup]);
    await this.viewportUpdate;
    this.page = undefined;
  }
  /** Explicit human recovery; no navigation or queued action is resumed here. */
  async resetEngine(): Promise<void> {
    this.cursorReader?.destroy();
    this.cursorReader = undefined;
    await this.workflows.clear();
    this.invalidateDisplay();
    this.stopNavigation?.(); this.stopNavigation = undefined;
    const page = this.page,
      cdp = this.cdp;
    const pointerCleanup = this.pointerLock.detach();
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
    const inputCleanup = this.input?.reset();
    this.input?.destroy();
    this.input = undefined;
    await page?.close({ runBeforeUnload: false }).catch(() => undefined);
    await cdp?.detach().catch(() => undefined);
    await Promise.all([pointerCleanup, inputCleanup]);
    await this.viewportUpdate;
  }
}
