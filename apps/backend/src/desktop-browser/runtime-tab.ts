import type { BrowserContext, CDPSession, Page } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import type {
  BrowserElement,
  TaskBrowserTab,
  TaskBrowserStreamEvent,
} from '@elevenex/shared';
import { RuntimeBrowserNetwork, runtimeUrl } from './runtime-network.js';

export interface RuntimeFrame {
  readonly sequence: number;
  readonly width: number;
  readonly height: number;
  readonly jpeg: Buffer;
}
/** A tab has one driver, one navigation generation, one frame waiter and no text observation. */
export class RuntimeBrowserTab {
  readonly id = randomUUID();
  driver: 'you' | 'agent' | 'needs';
  generation = 1;
  ownership = 0;
  waiting = false;
  agentSessionId: number | null;
  url = '';
  documentUrl = '';
  loading = false;
  error: string | null = null;
  errors = 0;
  width: 'full' | 'phone' = 'full';
  theme: 'light' | 'dark' | 'system' = 'system';
  slowNetwork = false;
  private canGoBack = false;
  private historyPending = false;
  step?: TaskBrowserTab['step'];
  target?: BrowserElement;
  picking = false;
  private page?: Page;
  private context?: BrowserContext;
  private cdp?: CDPSession;
  private disposed = false;
  private crashed = false;
  private layoutRevision = 0;
  private navigation = 0;
  private visible = false;
  private interactive = false;
  private pixelRatio = 1;
  private viewport = { width: 800, height: 600 };
  private network: RuntimeBrowserNetwork;
  private frame?: RuntimeFrame;
  private frameSequence = 0;
  private waiter?: {
    after: number;
    resolve(frame: RuntimeFrame | null): void;
    timer: ReturnType<typeof setTimeout>;
  };
  private streaming = false;
  private snapshotPending?: Promise<void>;
  private outstanding = false;
  private frameSent = 0;
  private quality = 85;
  private maxWidth = 1920;
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
    this.ownership++;
    this.waiting ||= this.driver === 'agent';
    this.driver = needs ? 'needs' : 'you';
    this.generation++;
    this.target = undefined;
  }
  handoff(sessionId: number): void {
    this.ownership++;
    this.agentSessionId = sessionId;
    this.driver = 'agent';
    this.waiting = false;
    this.generation++;
    this.step = { n: 1, text: 'Waiting for a browser action' };
  }
  assertAgent(generation: number, sessionId: number, visible = false): void {
    if (
      this.driver !== 'agent' ||
      this.generation !== generation ||
      this.agentSessionId !== sessionId ||
      (visible && !this.ready)
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
      !this.error &&
      !this.disposed
    );
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
    page.on('console', (message) => {
      if (message.type() === 'error') this.countError();
    });
    page.on('requestfailed', () => this.countError());
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
      this.frame = undefined;
      this.streaming = false;
      this.completeFrame(null);
      this.changed();
    });
    page.on('framenavigated', (frame) => {
      if (this.page !== page) return;
      if (frame === page.mainFrame()) {
        this.navigation++;
        this.generation++;
        try {
          this.url = runtimeUrl(frame.url()).href;
          this.documentUrl = this.url;
        } catch {
          /* Initial blank page. */
        }
        this.target = undefined;
        void this.history();
        this.changed();
      }
    });
    this.cdp.on(
      'Page.screencastFrame',
      (event: {
        sessionId: number;
        data: string;
        metadata: { deviceWidth: number; deviceHeight: number };
      }) => {
        if (this.page !== page) return;
        void this.cdp
          ?.send('Page.screencastFrameAck', { sessionId: event.sessionId })
          .catch(() => undefined);
        if (
          !this.visible ||
          !this.streaming ||
          this.disposed ||
          event.data.length > 4000000
        )
          return;
        const matches = (actual: number, expected: number) =>
          Math.abs(actual - expected) < 2 ||
          Math.abs(actual - expected * this.pixelRatio) < 2;
        if (
          !matches(event.metadata.deviceWidth, this.viewport.width) ||
          !matches(event.metadata.deviceHeight, this.viewport.height)
        )
          return;
        this.frame = {
          sequence: ++this.frameSequence,
          width: this.viewport.width,
          height: this.viewport.height,
          jpeg: Buffer.from(event.data, 'base64'),
        };
        this.flushFrame();
        if (this.outstanding && Date.now() - this.frameSent > 1000)
          void this.stopFrames();
      },
    );
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
      if (history.entries.length > 100) {
        await this.cdp.send('Page.resetNavigationHistory');
        this.canGoBack = false;
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
    return {
      id: this.id,
      title,
      url: this.url,
      by: this.by,
      driver: this.driver,
      agentSessionId: this.agentSessionId,
      generation: this.generation,
      loading: this.loading,
      ready: this.ready,
      canGoBack: this.canGoBack,
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
    this.loading = true;
    this.error = null;
    this.changed();
    try {
      await this.page!.goto(url.href, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
    } catch {
      this.error =
        'This page could not load. Check the address or task server, then retry.';
    } finally {
      this.loading = false;
      this.changed();
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
    if (this.interactive && !interactive && this.driver === 'agent') {
      this.generation++;
      this.target = undefined;
    }
    this.visible = visible;
    this.interactive = interactive;
    if (changed) this.changed();
    if (!visible) {
      this.takeover();
      this.frame = undefined;
      this.completeFrame(null);
      await this.stopFrames();
      return;
    }
    const viewport = {
      width: Math.max(100, Math.min(2560, Math.round(width))),
      height: Math.max(100, Math.min(1600, Math.round(height))),
    };
    const resized =
      viewport.width !== this.viewport.width ||
      viewport.height !== this.viewport.height;
    if (resized || pixelRatio !== this.pixelRatio) {
      await this.stopFrames();
      if (!current()) return;
      this.frame = undefined;
      this.completeFrame(null);
    }
    if (resized) {
      if (this.viewport.width !== viewport.width) this.takeover();
      else this.generation++;
      this.viewport = viewport;
      await this.page?.setViewportSize(viewport);
      if (!current()) return;
    }
    if (resized || pixelRatio !== this.pixelRatio) {
      this.pixelRatio = pixelRatio;
      await this.cdp?.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: pixelRatio,
        mobile: false,
      });
      if (!current()) return;
    }
    await this.page?.bringToFront();
    if (!current()) return;
    await this.startFrames();
  }
  private async startFrames(): Promise<void> {
    if (this.streaming || !this.cdp || !this.visible) return;
    this.streaming = true;
    try {
      await this.cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this.quality,
        maxWidth: this.maxWidth,
        maxHeight: 1440,
        everyNthFrame: 2,
      });
    } catch {
      this.streaming = false;
    }
  }
  private async stopFrames(): Promise<void> {
    this.streaming = false;
    await this.cdp?.send('Page.stopScreencast').catch(() => undefined);
  }
  async nextFrame(
    after: number,
    signal: AbortSignal,
  ): Promise<RuntimeFrame | null> {
    signal.throwIfAborted();
    if (this.waiter) throw new Error('A frame read is already pending');
    if (this.outstanding) {
      const elapsed = Date.now() - this.frameSent,
        quality = elapsed > 250 ? 65 : 85,
        width = elapsed > 250 ? 1280 : 1920;
      this.outstanding = false;
      if (quality !== this.quality || width !== this.maxWidth) {
        this.quality = quality;
        this.maxWidth = width;
        this.frame = undefined;
        await this.stopFrames();
        await this.startFrames();
      }
    }
    if (this.frame && this.frame.sequence > after) {
      this.outstanding = true;
      this.frameSent = Date.now();
      return this.frame;
    }
    if (!this.visible) return null;
    await this.startFrames();
    signal.throwIfAborted();
    return new Promise((resolve) => {
      const abort = () => this.completeFrame(null);
      const timer = setTimeout(abort, 5000);
      const fallback = setTimeout(() => {
        void this.staticFrame();
      }, 300);
      this.waiter = {
        after,
        timer,
        resolve: (frame) => {
          signal.removeEventListener('abort', abort);
          clearTimeout(fallback);
          resolve(frame);
        },
      };
      signal.addEventListener('abort', abort, { once: true });
      this.flushFrame();
    });
  }
  private async staticFrame(): Promise<void> {
    if (this.snapshotPending || !this.cdp || !this.visible || this.disposed)
      return;
    const sequence = this.frameSequence,
      generation = this.generation;
    const capture = this.cdp
      .send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: this.quality,
        captureBeyondViewport: false,
        fromSurface: true,
        clip: {
          x: 0,
          y: 0,
          width: this.viewport.width,
          height: this.viewport.height,
          scale: Math.min(
            1,
            this.maxWidth / (this.viewport.width * this.pixelRatio),
            1440 / (this.viewport.height * this.pixelRatio),
          ),
        },
      })
      .then((reply) => {
        if (
          this.disposed ||
          !this.visible ||
          this.generation !== generation ||
          this.frameSequence !== sequence ||
          reply.data.length > 4000000
        )
          return;
        this.frame = {
          sequence: ++this.frameSequence,
          width: this.viewport.width,
          height: this.viewport.height,
          jpeg: Buffer.from(reply.data, 'base64'),
        };
        this.flushFrame();
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.snapshotPending === capture) this.snapshotPending = undefined;
      });
    this.snapshotPending = capture;
    await capture;
  }
  private flushFrame(): void {
    if (this.waiter && this.frame && this.frame.sequence > this.waiter.after) {
      this.outstanding = true;
      this.frameSent = Date.now();
      this.completeFrame(this.frame);
    }
  }
  private completeFrame(frame: RuntimeFrame | null): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
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
      navigation = this.navigation;
    const current = () => {
      if (
        !this.ready ||
        this.generation !== acceptedGeneration ||
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
    if (input.kind === 'pointer')
      await this.cdp!.send('Input.dispatchMouseEvent', {
        type:
          input.type === 'down'
            ? 'mousePressed'
            : input.type === 'up'
              ? 'mouseReleased'
              : 'mouseMoved',
        x: input.x,
        y: input.y,
        button: input.button,
        buttons: input.buttons,
        clickCount: input.clicks,
        modifiers: input.modifiers,
      });
    else if (input.kind === 'wheel')
      await this.cdp!.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: input.x,
        y: input.y,
        deltaX: input.deltaX,
        deltaY: input.deltaY,
        modifiers: input.modifiers,
      });
    else if (input.kind === 'text')
      await this.page!.keyboard.insertText(input.text);
    else if (input.kind === 'composition')
      await this.cdp!.send('Input.imeSetComposition', {
        text: input.text,
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd,
      });
    else if (input.kind === 'edit')
      await this.page!.keyboard.press(
        input.operation === 'undo'
          ? 'ControlOrMeta+Z'
          : 'ControlOrMeta+Shift+Z',
      );
    else if (input.kind === 'key')
      await this.cdp!.send('Input.dispatchKeyEvent', {
        type: input.type === 'down' ? 'keyDown' : 'keyUp',
        key: input.key,
        code: input.code,
        windowsVirtualKeyCode: input.keyCode,
        modifiers: input.modifiers,
        ...(input.type === 'down' && input.key === 'Enter'
          ? { text: '\r' }
          : {}),
      });
    else if (input.kind === 'clipboard') {
      if (input.operation === 'selectAll')
        await this.page!.keyboard.press('ControlOrMeta+A');
      else if (input.operation === 'copy' || input.operation === 'cut') {
        const text = await this.page!.evaluate(() => {
          const active = document.activeElement;
          if (active instanceof HTMLInputElement && active.type === 'password')
            return '';
          if (
            active instanceof HTMLInputElement ||
            active instanceof HTMLTextAreaElement
          )
            return active.value.slice(
              active.selectionStart ?? 0,
              active.selectionEnd ?? 0,
            );
          return getSelection()?.toString() ?? '';
        });
        current();
        if (input.operation === 'cut' && text)
          await this.page!.keyboard.press('Backspace');
        this.changed();
        return { clipboard: text.slice(0, 65536) };
      } else throw new Error('Paste must be provided by the viewing device');
    }
    this.changed();
    return {};
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
    await this.page!.mouse.move(atX, atY);
    this.assertAgent(generation, sessionId, true);
    await this.page!.mouse.wheel(x, y);
  }
  async themeTo(
    theme: 'system' | 'light' | 'dark',
    system: 'light' | 'dark' = 'light',
  ): Promise<void> {
    await this.page!.emulateMedia({
      colorScheme: theme === 'system' ? system : theme,
    });
    this.theme = theme;
  }
  async networkTo(slow: boolean): Promise<void> {
    await this.cdp!.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: slow ? 150 : 0,
      downloadThroughput: slow ? 200000 : -1,
      uploadThroughput: slow ? 90000 : -1,
    });
    this.slowNetwork = slow;
  }
  async back(): Promise<void> {
    await this.page?.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 });
  }
  async destroy(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.takeover();
    this.completeFrame(null);
    await this.stopFrames();
    await this.page?.close({ runBeforeUnload: false });
    this.page = undefined;
  }
  /** Explicit human recovery; no navigation or queued action is resumed here. */
  async resetEngine(): Promise<void> {
    const page = this.page,
      cdp = this.cdp;
    this.page = undefined;
    this.cdp = undefined;
    this.layoutRevision++;
    this.visible = false;
    this.interactive = false;
    this.pixelRatio = 1;
    this.viewport = { width: 0, height: 0 };
    this.frame = undefined;
    this.streaming = false;
    this.outstanding = false;
    this.snapshotPending = undefined;
    this.completeFrame(null);
    this.crashed = false;
    this.error = null;
    this.loading = true;
    this.takeover();
    await cdp?.detach().catch(() => undefined);
    await page?.close({ runBeforeUnload: false }).catch(() => undefined);
  }
}
