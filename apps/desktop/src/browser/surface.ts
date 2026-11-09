import { AgentDownloads } from './agent-downloads';
import { nativeBrowserInput } from './native-input';
import { AgentNativeInput } from './agent-input';
import { pickBrowserElement, delay, ProtocolLease, type BrowserAgentTarget } from '@elevenex/browser-agent';
import { hardenTaskGuest } from './guest-policy';
import { WebContentsView } from 'electron';
import { BrowserFrameStream } from './frame-stream';
import { clipboard, app } from 'electron';
import { randomUUID } from 'node:crypto';
import { type BrowserWindow, type Rectangle, type WebContents, type Session } from 'electron';
import type { BrowserElement, TaskBrowserTab, TaskBrowserFrame, TaskBrowserStreamEvent } from '@elevenex/shared';
import { BrowserDriverLease } from './driver';
import { browserUrl } from './validation';
import { elementAt } from './page-inspection';

export interface BrowserPageHost {
  readonly window: BrowserWindow;
  resourceUrl(url: string): string | null;
  logicalUrl(url: string): string;
  configure(session: Session): Promise<void>;
  authorize?(url: string): Promise<void>;
  popup?(sessionId: number, options: Electron.BrowserWindowConstructorOptions): WebContents;
  changed(): void;
  controlChanged?(): void;
  frame(frame: TaskBrowserFrame): void;
  readonly scopeId: string;
  readonly taskId: number;
  readonly session: Session;
  readonly partition: string;
  authorized(): boolean;
  pick(element: BrowserElement | null): void;
  attention(kind: 'popup' | 'dialog', message: string): void;
  shortcut(kind: 'open' | 'pick' | 'controls'): void;
}
/** One sandboxed, unprivileged page. The creating task owns and destroys it explicitly. */
export class BrowserPage {
  agentPicker?: (x: number, y: number) => Promise<void>;
  agentSelectionPaused = false;
  get documentId(): string { return this.bootstrap + ':' + this.navigation; }
  private playwrightConnections = 0;
  private readonly downloads = new AgentDownloads();
  acceptAgentDownload(item: Electron.DownloadItem): boolean { return this.agentPlaywright && this.downloads.accept(item); }
  get agentPlaywright(): boolean { return this.lease.driver === 'agent' && this.playwrightConnections > 0; }
  private readonly agentInputs = new Set<AgentNativeInput>();
  private agentView?: WebContentsView;
  private agentBlank?: Promise<void>;
  private agentPopup = false;
  get independent(): boolean { return !!this.agentView; }
  /** Agent tabs can start while their panel is hidden. Main owns an offscreen
   * sandboxed view; the existing stream surface displays it when requested. */
  ensureAgentView(popup?: Electron.BrowserWindowConstructorOptions): void {
    if (this.hasContents) return;
    // Electron supplies opener metadata in these preferences. Preserve it while
    // pinning the task session and reapplying every security setting.
    const preferences: Electron.WebPreferences = { ...popup?.webPreferences, session: this.pageSession, partition: this.partition, offscreen: true };
    if (!hardenTaskGuest(preferences, { partition: this.partition, src: this.bootstrap }, this.partition, this.bootstrap)) throw new Error('Invalid agent page preferences');
    preferences.backgroundThrottling = false; preferences.disableDialogs = false;
    this.agentPopup = popup !== undefined;
    // createWindow receives an already-created WebContents. Replacing it loses
    // the opener and can strand window.open() in Chromium's creation handshake.
    const supplied = popup ? Reflect.get(popup, 'webContents') as WebContents | undefined : undefined;
    if (supplied) {
      const inherited = popup!.webPreferences!;
      if (supplied.session !== this.pageSession || !inherited.sandbox || !inherited.contextIsolation || inherited.nodeIntegration || inherited.webviewTag || !inherited.webSecurity) throw new Error('Unsafe popup preferences');
    }
    this.agentView = new WebContentsView(supplied ? { webContents: supplied } : { webPreferences: preferences });
    // A native parent establishes the renderer's viewport. Keep the view hidden;
    // presentation uses the existing pixel stream, never a native overlay.
    this.host.window.contentView.addChildView(this.agentView);
    this.agentView.setVisible(false);
    this.agentView.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
    this.presentation = 'stream';
    this.attach(this.agentView.webContents);
  }
  async agentTarget(sessionId: number, active: () => boolean, goto: BrowserAgentTarget['goto'], close: () => Promise<void>, signal: AbortSignal, human?: () => boolean): Promise<BrowserAgentTarget> {
    const ownership = this.lease.ownership;
    const assert = () => {
      if (!active() || this.destroyed || (!human && (this.lease.driver !== 'agent' || this.lease.agentSessionId !== sessionId)) || (human && (!human() || this.lease.driver === 'agent')) || this.lease.ownership !== ownership) throw new Error('Tab control changed; wait for handoff and get a fresh handle');
    };
    assert();
    while (!this.hasContents || this.initializing) { assert(); await delay(25, signal); }
    // A newly constructed native view has no document yet. CDP Runtime.enable
    // waits for one, so load the inert document before installing observation.
    if (this.independent && !this.agentPopup && !this.contents.getURL()) await (this.agentBlank ??= this.contents.loadURL('about:blank'));
    assert(); signal.throwIfAborted();
    const contents = this.contents, debuggerApi = contents.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
    const targetInfo = await debuggerApi.sendCommand('Target.getTargetInfo') as { targetInfo: { targetId: string } };
    const attached = await debuggerApi.sendCommand('Target.attachToTarget', { targetId: targetInfo.targetInfo.targetId, flatten: true }) as { sessionId: string };
    const protocolSession = attached.sessionId;
    try {
    let playing = false, closed = false;
    assert();
    const native = new AgentNativeInput(contents, input => {
      this.syntheticInput = true;
      try { contents.sendInputEvent(input); } finally { this.syntheticInput = false; }
    });
    const children = new Set<string>();
    const raw = async (method: string, params: Record<string, unknown>, child?: string) => {
      if (method.startsWith('Input.')) await debuggerApi.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }, child ?? protocolSession);
      return await ((!child ? native.send(method, params) : null) ?? debuggerApi.sendCommand(method, params, child ?? protocolSession));
    };
    const lease = new ProtocolLease(raw, () => debuggerApi.sendCommand('Target.detachFromTarget', { sessionId: protocolSession }));
    const receive = (_event: Electron.Event, method: string, params: unknown, id?: string) => {
      if (id !== protocolSession && (!id || !children.has(id))) return;
      if (method === 'Target.attachedToTarget' && params && typeof params === 'object') { const child = Reflect.get(params, 'sessionId'); if (typeof child === 'string') children.add(child); }
      lease.receive(method, params, id === protocolSession ? undefined : id);
    };
    this.agentInputs.add(native); contents.setIgnoreMenuShortcuts(true); debuggerApi.on('message', receive);
    return {
      id: this.id, assert: () => { assert(); if (!this.hasContents || this.contents !== contents) throw new Error('Browser engine replaced'); },
      send: async (method, params, child) => { assert(); return lease.send(method, params, child); },
      subscribe: listener => {
        const stopEvents = lease.subscribe(listener), stop = this.lease.subscribe(() => listener('Elevenex.controlRevoked', {}));
        return () => { stop(); stopEvents(); };
      },
      authorize: async (url, pending) => { assert(); pending.throwIfAborted(); browserUrl(url); await this.host.authorize?.(url); await this.host.configure(this.pageSession); pending.throwIfAborted(); if (!this.host.resourceUrl(url)) throw new Error('Task destination is not authorized'); },
      playwright: async () => { await this.downloads.prepare(); if (!playing) { playing = true; this.playwrightConnections++; } },
      subscribeDownloads: listener => this.downloads.subscribe(listener),
      dispose: async () => { if (closed) return; closed = true; if (playing) this.playwrightConnections--; native.release(); await lease.dispose(); debuggerApi.removeListener('message', receive); this.agentInputs.delete(native); if (!this.agentInputs.size && !contents.isDestroyed()) contents.setIgnoreMenuShortcuts(false); },
      goto: async (url, pending) => { assert(); await goto(url, pending); assert(); },
      close: async () => { assert(); if (this.lease.by !== 'agent') throw new Error('User-created tabs require user closure'); await close(); },
      interrupt: () => { assert(); native.release(); void debuggerApi.sendCommand('Runtime.terminateExecution').catch(() => undefined); void debuggerApi.sendCommand('Page.stopLoading').catch(() => undefined); },
    };
    } catch (error) { await debuggerApi.sendCommand('Target.detachFromTarget', { sessionId: protocolSession }).catch(() => undefined); throw error; }
  }
  readonly id: string;
  readonly bootstrap: string;
  displayWindow?: BrowserWindow;
  readonly lease: BrowserDriverLease;
  private engine?: WebContents;
  get contents(): WebContents { if (!this.engine) throw new Error('The page is still connecting'); return this.engine; }
  get requested(): boolean { return !!this.engine || !!this.pendingLoad; }
  get hasContents(): boolean { return !!this.engine && !this.engine.isDestroyed() && !this.crashed; }
  get partition(): string { return this.host.partition; }
  presentation: 'embedded' | 'stream' = 'embedded';
  private frames?: BrowserFrameStream;
  private pendingLoad?: { logical: string; actual: string; generation: number };
  private disposedInput = 0;
  url = '';
  documentUrl = '';
  private pageTitle?: { url: string; text: string };
  loading = false;
  error: string | null = null;
  errors = 0;
  width: 'full' | 'phone' = 'full';
  theme: 'light' | 'dark' | 'system' = 'system';
  slowNetwork = false;
  step?: TaskBrowserTab['step'];
  target?: BrowserElement;
  picking = false;
  visualPicking = false;
  userDownloadIntent = false;
  reducedMotion = false;
  attached = false;
  viewport = { width: 0, height: 0 };
  private zoom = 1;
  bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  private destroyed = false;
  private crashed = false;
  private syntheticInput = false;
  private navigation = 0;
  private viewportRevision = 0;
  get selectionViewportId(): string { return this.viewportRevision + ":" + this.attached; }
  private layoutGeneration = 0;
  private inputReady = false;
  private readonly heldMouse = new Map<string, number>();
  private readonly heldKeys = new Map<string, number>();
  get ready(): boolean { return this.attached && this.inputReady && this.layoutGeneration === this.lease.generation && !this.loading && !this.error; }
  private loadTimer?: ReturnType<typeof setTimeout>;
  private inspection?: Promise<BrowserElement | null>;
  private cancelTool?: () => void;
  private networkReady?: Promise<void>;
  private initializing = false;
  private readonly pageSession;


  constructor(private readonly host: BrowserPageHost, by: 'you' | 'agent', sessionId: number | null = null, id: string = randomUUID()) {
    this.id = id;
    // A tab survives engine recovery; a main-issued guest identity does not.
    this.bootstrap = 'about:blank#' + id + ':' + randomUUID();
    if (process.env['ELECTRON_ENABLE_LOGGING'] || app.commandLine.hasSwitch('enable-logging')) throw new Error('Private browsing is unavailable while Chromium page logging is enabled. Disable page logging before opening a tab.');
    this.lease = new BrowserDriverLease(by, sessionId, () => { for (const input of this.agentInputs) input.release(); }, () => host.controlChanged?.());
    if (by === 'agent') this.step = { n: 1, text: 'Opening page' };
    // The task owns a durable profile shared by its tabs; Chromium keeps site data
    // across task eviction and application restarts.
    this.pageSession = host.session;

  }
  accepts(contents: WebContents): boolean { return !this.destroyed && !this.engine && contents.session === this.pageSession; }
  attach(contents: WebContents): void {
    if (!this.accepts(contents)) throw new Error('Invalid browser guest');
    this.engine = contents;
    this.initializing = true;
    this.frames = new BrowserFrameStream(contents, { scopeId: this.host.scopeId, taskId: this.host.taskId, tabId: this.id }, this.host.frame);
    const host = this.host;
    contents.setAudioMuted(false);
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    contents.on('select-client-certificate', (event, _url, _certificates, callback) => {
      event.preventDefault();
      // Electron 45's WebContents types require a certificate, but its documented
      // no-argument callback denies selection. Never auto-send an OS credential.
      Reflect.apply(callback, undefined, []);
    });
    contents.setWindowOpenHandler(() => {
      if (this.agentPlaywright && this.host.popup && this.lease.agentSessionId) return {
        action: 'allow',
        overrideBrowserWindowOptions: { webPreferences: { session: this.pageSession, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false, devTools: false, backgroundThrottling: false, disableDialogs: false } },
        createWindow: options => this.host.popup!(this.lease.agentSessionId!, options),
      };
      this.lease.takeOver(true); host.attention('popup', 'This site requested a popup window. Continue this workflow outside; sign-in state is separate.'); return { action: 'deny' };
    });
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('content-bounds-updated', event => event.preventDefault());
    contents.on('will-prevent-unload', event => event.preventDefault());
    const navigation = (event: Electron.Event, url: string) => {
      try { browserUrl(url); if (host.resourceUrl(url) === null) event.preventDefault(); } catch { event.preventDefault(); }
    };
    contents.on('will-navigate', navigation);
    contents.on('will-redirect', navigation);
    contents.on('did-start-navigation', (_event, _url, inPlace, main) => {
      if (!main) return;
      this.navigation++; this.lease.generation++; this.target = undefined; this.heldMouse.clear(); this.heldKeys.clear();
      if (!inPlace) { this.loading = true; this.error = null; }
      host.changed();
    });
    const navigated = () => {
      if (this.destroyed) return;
      const url = contents.getURL();
      try { this.url = host.logicalUrl(browserUrl(url)); this.documentUrl = this.url; } catch { return; }
      const history = contents.navigationHistory;
      while (history.length() > 100 && history.removeEntryAtIndex(0)) { /* Bound retained navigation entries. */ }
      host.changed();
    };
    contents.on('did-navigate', navigated);
    contents.on('did-navigate-in-page', () => {
      if (this.pageTitle) this.pageTitle.url = host.logicalUrl(contents.getURL());
      navigated();
    });
    contents.on('page-title-updated', (_event, title, explicitSet) => {
      if (this.destroyed) return;
      this.pageTitle = { url: host.logicalUrl(contents.getURL()), text: explicitSet ? title.replace(/\s+/gu, ' ').trim().slice(0, 200) : '' };
      host.changed();
    });
    contents.on('did-stop-loading', () => { if (this.loadTimer) clearTimeout(this.loadTimer); this.loadTimer = undefined; this.loading = false; navigated(); host.changed(); });
    contents.on('did-fail-load', (_event, code, _description, _url, main) => {
      if (!main || code === -3) return;
      this.loading = false; this.error = 'This page could not load. Check the address or task server, then retry.';
      this.hide(); host.changed();
    });
    contents.on('destroyed', () => {
      if (this.destroyed) return;
      this.lease.takeOver(true); this.loading = false;
      this.error = 'The page closed. Reload to open it again with user control.';
      this.hide(); host.changed();
    });
    contents.on('render-process-gone', () => {
      this.crashed = true;
      this.lease.takeOver(true); this.loading = false;
      this.error = 'The page stopped. Reload to recover; agent control stays paused.';
      this.hide(); host.changed();
    });
    // No raw messages, URLs, headers or request bodies are retained or forwarded.
    contents.on('console-message', details => { if (details.level === 'error') this.countError(); });
    contents.on('before-input-event', (event, input) => {
      if (this.syntheticInput) return;
      if (this.agentSelectionPaused) { event.preventDefault(); return; }
      const key = input.code || input.key;
      const release = input.type === 'keyUp' && this.heldKeys.get(key) === this.navigation;
      if (input.type === 'keyUp') this.heldKeys.delete(key);
      if (!this.attached || !this.inputReady) {
        if (release && this.attached && host.authorized() && this.lease.driver !== 'agent') return;
        event.preventDefault(); return;
      }
      if (this.syntheticInput) return;
      if (this.agentSelectionPaused) { event.preventDefault(); return; }
      if (input.type === 'keyDown' && this.heldKeys.size < 128) this.heldKeys.set(key, this.navigation);
      if (input.type === 'keyDown') this.userDownloadIntent = true;
      // Revoke synchronously before Chromium accepts the user's key. Async/queued agent
      // work rechecks the generation after every await and immediately before dispatch.
      if (this.lease.driver === 'agent') { this.lease.takeOver(); host.changed(); }
      if (input.shift && input.key === 'Escape' && input.type === 'keyDown') { event.preventDefault(); host.shortcut('controls'); return; }
      if ((input.meta || input.control) && input.type === 'keyDown' && (input.key.toLowerCase() === 't' || (input.shift && input.key.toLowerCase() === 'c'))) {
        event.preventDefault(); host.shortcut(input.key.toLowerCase() === 't' ? 'open' : 'pick');
      }
    });
    contents.on('before-mouse-event', (event, mouse) => {
      if (this.syntheticInput) return;
      const button = mouse.button || 'left';
      const release = mouse.type === 'mouseUp' && this.heldMouse.get(button) === this.navigation;
      if (mouse.type === 'mouseUp') this.heldMouse.delete(button);
      if (!this.attached || !this.inputReady) {
        // A visible page finishes an already accepted human gesture even when
        // app chrome starts moving. New gestures and all hidden input stay gated.
        if (release && this.attached && host.authorized() && this.lease.driver !== 'agent') return;
        event.preventDefault(); return;
      }
      if (this.syntheticInput) return;
      if (mouse.type === 'mouseDown') this.heldMouse.set(button, this.navigation);
      if (mouse.type === 'mouseDown') this.userDownloadIntent = true;
      if (mouse.type === 'mouseDown' || mouse.type === 'mouseWheel') {
        if (this.lease.driver === 'agent') { this.lease.takeOver(); host.changed(); }
      }
      if (this.picking) {
        this.heldMouse.delete(button);
        event.preventDefault();
        if (mouse.type === 'mouseDown') { const zoom = contents.getZoomFactor(); void this.pickAt(mouse.x / zoom, mouse.y / zoom); }
      }
    });
    void this.initialize();
  }
  private async initialize(): Promise<void> {
    try {
      // Settings describe this tab, but CDP emulation belongs to its current
      // WebContents. Reapply it before loading after detach/return rehosting.
      if (this.theme !== 'system') await this.tool('theme', this.theme);
      if (this.destroyed) return;
      if (this.slowNetwork) await this.tool('network', true);
      if (this.destroyed) return;
      this.initializing = false;
      const pending = this.pendingLoad;
      this.pendingLoad = undefined;
      if (pending) {
        if (this.host.authorized() && pending.generation === this.lease.generation) this.load(pending.logical, pending.actual);
        else { this.loading = false; this.error = 'Opening this page was interrupted. Retry explicitly.'; }
      }
    } catch {
      if (this.destroyed) return;
      this.initializing = false;
      this.pendingLoad = undefined;
      this.loading = false;
      this.error = 'Page settings could not be restored. Reload before trying again.';
      this.theme = 'system'; this.slowNetwork = false;
      this.lease.takeOver(); this.hide();
      // Do not retain a half-configured engine whose emulation disagrees with
      // the controls. Reload creates a fresh guest with the default settings.
      if (this.hasContents) this.contents.close({ waitForBeforeUnload: false });
    }
    this.host.changed();
  }
  decorate(): void { /* Trusted renderer chrome owns all visual decoration. */ }
  snapshot(): TaskBrowserTab {
    let title = 'New tab';
    try { const url = new URL(this.url); title = url.pathname === '/' ? url.host : url.pathname.slice(0, 160); } catch { /* Empty tab. */ }
    // Titles are human-facing presentation data; agent replies omit them.
    if (this.pageTitle?.url === this.url && this.url === this.documentUrl && this.pageTitle.text) title = this.pageTitle.text;
    return { id: this.id, title, url: this.url, by: this.lease.by, driver: this.lease.driver,
      agentSessionId: this.lease.agentSessionId, generation: this.lease.generation, waiting: this.lease.waiting, loading: this.loading, ready: this.ready,
      canGoBack: !this.destroyed && this.hasContents && this.contents.navigationHistory.canGoBack(), error: this.error,
      canGoForward: !this.destroyed && this.hasContents && this.contents.navigationHistory.canGoForward(),
      errors: this.errors, width: this.width, theme: this.theme, slowNetwork: this.slowNetwork, ...(this.step ? { step: this.step } : {}),
      ...(this.target ? { target: this.target } : {}) };
  }
  configureNetwork(): Promise<void> { return this.networkReady ??= this.host.configure(this.pageSession).catch(error => { this.networkReady = undefined; throw error; }); }
  pauseNetwork(): void { void this.pageSession.closeAllConnections().catch(() => undefined); }
  load(logical: string, actual: string): void {
    this.pageTitle = undefined;
    this.url = logical; this.error = null; this.loading = true; this.host.changed();
    if (this.loadTimer) clearTimeout(this.loadTimer);
    this.loadTimer = setTimeout(() => {
      this.loadTimer = undefined; if (this.destroyed || !this.loading) return;
      if (this.hasContents) this.contents.stop(); this.loading = false; this.error = 'This page took too long to load. Check its server, then retry.'; this.hide(); this.host.changed();
    }, 20000);
    if (!this.hasContents || this.initializing) { this.pendingLoad = { logical, actual, generation: this.lease.generation }; return; }
    void this.contents.loadURL(actual).catch(() => { /* did-fail-load supplies safe display text. */ });
  }
  show(bounds: Rectangle, zoom = 1, ownerGeneration = this.lease.generation, inputReady = true, viewport = { width: bounds.width / zoom, height: bounds.height / zoom }): void {
    if (this.inputReady && !inputReady && this.lease.driver === 'agent') { this.lease.generation++; this.target = undefined; this.host.changed(); }
    this.layoutGeneration = ownerGeneration; this.inputReady = inputReady && !this.initializing;
    const responsiveChange = this.viewport.width !== viewport.width || this.zoom !== zoom;
    if (responsiveChange || this.viewport.height !== viewport.height) {
      this.viewportRevision++;
      const hadViewport = this.viewport.width > 0 && this.viewport.height > 0;
      if (responsiveChange) this.target = undefined;
      if (hadViewport && this.lease.driver === 'agent') { if (responsiveChange) this.lease.takeOver(); else this.lease.generation++; this.host.changed(); }
    }
    this.bounds = bounds; this.viewport = viewport; this.zoom = zoom;
    this.agentView?.setBounds({ x: 0, y: 0, width: Math.max(2, Math.round(bounds.width)), height: Math.max(2, Math.round(bounds.height)) });
    if (this.destroyed || !this.hasContents || this.error || bounds.width < 2 || bounds.height < 2) { this.hide(); return; }
    if (this.contents.getZoomFactor() !== zoom) this.contents.setZoomFactor(zoom);
    this.contents.setAudioMuted(false);this.attached = true; this.frames?.setActive(this.presentation === 'stream');
  }
  hide(): void {
    this.heldMouse.clear(); this.heldKeys.clear();
    if (!this.attached) return;
    if(this.hasContents)this.contents.setAudioMuted(true);
    this.attached = false; this.disposedInput++;
    this.frames?.setActive(false);
    if (this.hasContents && this.contents.debugger.isAttached()) void this.contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined);
  }
  acknowledge(stream: string, sequence: number): void { this.frames?.acknowledge(stream, sequence); }
  async userInput(generation: number, input: TaskBrowserStreamEvent): Promise<void> {
    if (input.kind === 'release' || input.kind === 'pointer-exit' || input.kind === 'pointer-relative' || input.kind === 'pointer-unlock') throw new Error('This input requires a machine stream');
    if (!this.attached || !this.hasContents || !this.host.authorized() || this.presentation !== 'stream') throw new Error('Browser presentation or control changed');
    if (this.agentSelectionPaused) return;
    const previousGeneration = this.lease.generation;
    if (this.lease.driver === 'agent') { this.lease.takeOver(); this.host.changed(); }
    if (generation !== previousGeneration) throw new Error('Browser control changed');
    if ((input.kind === 'pointer' || input.kind === 'wheel') && (input.x >= this.viewport.width || input.y >= this.viewport.height)) throw new Error('Input is outside the page');
    if (input.kind !== 'pointer' || input.type === 'down') this.userDownloadIntent = true;
    // This is a human-input endpoint, never part of the automation mailbox.
    if (this.picking && input.kind === 'pointer') { if (input.type === 'down') await this.pickAt(input.x, input.y); return; }
    if (this.picking) return;
    const contents = this.contents, revision = this.disposedInput, acceptedGeneration = this.lease.generation;
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
    await contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    if (revision !== this.disposedInput || !this.attached || !this.inputReady || acceptedGeneration !== this.lease.generation || !this.host.authorized()) throw new Error('Browser input was interrupted before delivery');
    if (input.kind === 'pointer') await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: input.type === 'down' ? 'mousePressed' : input.type === 'up' ? 'mouseReleased' : 'mouseMoved', x: input.x, y: input.y, button: input.button, buttons: input.buttons, clickCount: input.clicks, modifiers: input.modifiers });
    else if (input.kind === 'wheel') await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY, modifiers: input.modifiers });
    else if (input.kind === 'key') {
      if (input.type === 'down' && input.key === 'Escape' && (input.modifiers & 8)) { this.host.shortcut('controls'); return; }
      await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: input.type === 'down' ? 'keyDown' : 'keyUp', key: input.key, code: input.code, windowsVirtualKeyCode: input.keyCode, modifiers: input.modifiers, ...(input.type === 'down' && (input.text !== undefined || input.key === 'Enter') ? { text: input.text ?? '\r' } : {}) });
    } else if (input.kind === 'composition') await contents.debugger.sendCommand('Input.imeSetComposition', { text: input.text, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd });
    else if (input.kind === 'edit') contents[input.operation]();
    else if (input.kind === 'text') await contents.insertText(input.text);
    else if (input.operation === 'paste') { const text = (await clipboard.readText()).slice(0, 65536); if (this.disposedInput !== revision || !this.inputReady || acceptedGeneration !== this.lease.generation || !this.attached || !this.host.authorized()) throw new Error('Browser control changed'); await contents.debugger.sendCommand('Input.insertText', { text }); }
    else contents[input.operation]();
  }
  async click(x: number, y: number, generation: number, step: string, n = 1, total?: number): Promise<void> {
    await this.prepareAgentInput(generation);
    const viewport = this.viewportRevision;
    if (x < 0 || y < 0 || x >= this.viewport.width || y >= this.viewport.height) throw new Error('Target is outside the visible page');
    const revision = this.navigation;
    const target = await this.inspectAt(x, y);
    this.assertInput(generation);
    if (revision !== this.navigation || viewport !== this.viewportRevision) throw new Error('The page or viewport changed; inspect state again');
    if (!target || target.tag === 'element') { this.lease.takeOver(true); this.host.changed(); throw new Error('Editable or embedded content requires the user. Observation remains withheld.'); }
    this.target = target; this.step = { n, text: step, ...(total === undefined ? {} : { total }) }; this.host.changed();
    // No delayed input, typing queues or automatic retries.
    const delivered = await nativeBrowserInput(this.contents, () => {
      if (!this.contents.debugger.isAttached()) this.contents.debugger.attach('1.3');
      this.syntheticInput = true;
      try {
        this.assertInput(generation);
        // Electron's synchronous dispatch emits its before-mouse hook in this
        // Main turn. An async CDP mouse command cannot safely mark that interval:
        // it would either revoke itself or mask a genuine user takeover.
        const zoom = this.contents.getZoomFactor();
        this.contents.sendInputEvent({ type: 'mouseDown', x: Math.round(x * zoom), y: Math.round(y * zoom), button: 'left', clickCount: 1 });
        this.contents.sendInputEvent({ type: 'mouseUp', x: Math.round(x * zoom), y: Math.round(y * zoom), button: 'left', clickCount: 1 });
        return Promise.resolve();
      } finally { this.syntheticInput = false; }
    }, () => this.assertInput(generation), 'click');
    if (!delivered) { this.lease.takeOver(true); this.host.changed(); throw new Error('The page did not confirm input delivery. Inspect it before retrying.'); }
  }
  async scroll(x: number, y: number, generation: number, atX?: number, atY?: number): Promise<void> {
    await this.prepareAgentInput(generation);
    const px = atX ?? this.viewport.width / 2, py = atY ?? this.viewport.height / 2;
    if (px < 0 || py < 0 || px >= this.viewport.width || py >= this.viewport.height) throw new Error('Scroll target is outside the visible page');
    this.target = undefined; this.step = { ...this.step, n: this.step?.n ?? 1, text: 'Scrolling page' }; this.host.changed();
    const delivered = await nativeBrowserInput(this.contents, () => {
      if (!this.contents.debugger.isAttached()) this.contents.debugger.attach('1.3');
      this.syntheticInput = true;
      try { this.assertInput(generation); const zoom = this.contents.getZoomFactor(); this.contents.sendInputEvent({ type: 'mouseWheel', x: Math.round(px * zoom), y: Math.round(py * zoom), deltaX: x, deltaY: y, canScroll: true }); return Promise.resolve(); }
      finally { this.syntheticInput = false; }
    }, () => this.assertInput(generation), 'wheel');
    if (!delivered) { this.lease.takeOver(true); this.host.changed(); throw new Error('The page did not confirm scroll delivery. Inspect it before retrying.'); }
  }
  focus(): void {
    if (!this.attached || this.contents.isDestroyed() || !this.host.authorized()) throw new Error('The page is not visible');
    if (this.lease.driver === 'agent') this.lease.takeOver();
    if (this.presentation === 'embedded') this.contents.focus();
  }
  private async prepareAgentInput(generation: number): Promise<void> {
    this.assertInput(generation);
    if (!this.contents.debugger.isAttached()) this.contents.debugger.attach('1.3');
    // Guest widgets need document focus for trusted CDP delivery. Emulation does
    // not move OS/app focus; human events still revoke the lease synchronously.
    await this.contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    this.assertInput(generation);
  }
  private assertInput(generation: number): void {
    this.lease.assert(generation); if (!this.host.authorized() || !(this.displayWindow ?? this.host.window).isVisible() || (this.displayWindow ?? this.host.window).isMinimized() || !this.ready || this.destroyed || this.loading || this.error) throw new Error('Agent input requires a visible, loaded page with native delivery confirmation');
  }
  async tool(kind: 'theme' | 'network', value: string | boolean): Promise<void> {
    const contents = this.contents;
    if (this.cancelTool || contents.isDestroyed()) throw new Error('Page tools are busy or the page is closed');
    const debuggerApi = contents.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let cancel: () => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => {
        if (finished) return;
        finished = true; clearTimeout(deadline);
        reject(new Error('Page tools stopped responding. Reload before trying again.'));
        if (!contents.isDestroyed() && debuggerApi.isAttached()) debuggerApi.detach();
        this.theme = 'system'; this.slowNetwork = false; this.lease.takeOver();
        if (!this.destroyed) this.host.changed();
      };
      deadline = setTimeout(cancel, 2000);
    });
    this.cancelTool = cancel;
    try {
      if (kind === 'theme' && (value === 'light' || value === 'dark' || value === 'system')) {
        await Promise.race([debuggerApi.sendCommand('Emulation.setEmulatedMedia', { features: value === 'system' ? [] : [{ name: 'prefers-color-scheme', value }] }), cancelled]);
        this.theme = value;
      } else if (kind === 'network' && typeof value === 'boolean') {
        // Chromium accepts the emulation command without applying it until the
        // Network domain is enabled. Retain no request bodies or posted data.
        await Promise.race([debuggerApi.sendCommand('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 }), cancelled]);
        await Promise.race([debuggerApi.sendCommand('Network.emulateNetworkConditions', { offline: false, latency: value ? 150 : 0, downloadThroughput: value ? 200_000 : -1, uploadThroughput: value ? 90_000 : -1 }), cancelled]);
        this.slowNetwork = value;
      } else throw new Error('Unsupported browser tool setting');
    } finally {
      finished = true; clearTimeout(deadline);
      if (this.cancelTool === cancel) this.cancelTool = undefined;
    }
  }
  private inspectAt(x: number, y: number, sourceCurrent?: () => boolean): Promise<BrowserElement | null> {
    if (this.inspection) return Promise.reject(new Error('The page is still responding to its previous inspection'));
    const operation = elementAt(this.contents, x, y, sourceCurrent); this.inspection = operation;
    void operation.finally(() => { if (this.inspection === operation) this.inspection = undefined; }).catch(() => undefined);
    return operation;
  }
  private pickingBusy = false;
  get capturePending(): boolean { return this.pickingBusy; }
  private async pickAt(x: number, y: number): Promise<void> {
    if (this.agentPicker) { await this.agentPicker(x, y); return; }
    if (!this.visualPicking) {
      const generation = this.lease.generation, navigation = this.navigation, viewport = this.viewportRevision;
      const current = () => !this.destroyed && this.picking && this.attached && this.lease.generation === generation && this.navigation === navigation && this.viewportRevision === viewport;
      const element = await this.inspectAt(x, y, current).catch(() => null);
      if (current()) { this.hide(); this.host.pick(element); }
      return;
    }
    if (this.pickingBusy) return;
    this.pickingBusy = true;
    this.host.changed();
    const navigation = this.navigation, viewport = this.viewportRevision, generation = this.lease.generation;
    const current = () => !this.destroyed && this.picking && this.attached && this.navigation === navigation && this.viewportRevision === viewport && this.lease.generation === generation;
    try {
      const target = await this.agentTarget(1, () => current(), () => Promise.reject(new Error('Inspection cannot navigate')), () => Promise.reject(new Error('Inspection cannot close')), AbortSignal.timeout(15000), current);
      let element = await pickBrowserElement(target, x, y, this.documentId, current, process.versions.chrome);
      const hint = await this.inspectAt(x, y, current).catch(() => null);
      if (hint && hint.tag === element.tag && Math.abs(hint.x - element.x) < 0.5 && Math.abs(hint.y - element.y) < 0.5 && Math.abs(hint.width - element.width) < 0.5 && Math.abs(hint.height - element.height) < 0.5 && element.snapshot) {
        const sources = { ...(hint.source ? { source: hint.source } : {}), ...(hint.componentSource ? { componentSource: hint.componentSource } : {}) };
        element = { ...element, ...sources, snapshot: { ...element.snapshot, reference: { ...element.snapshot.reference, ...sources } } };
      }
      if (current()) { this.hide(); this.host.pick(element); }
    } catch { if (current()) this.host.pick(null); } finally { this.pickingBusy = false; this.host.changed(); }
  }
  countError(): void { if (this.destroyed || !this.host.authorized() || this.errors >= 999) return; this.errors++; this.host.changed(); }
  destroy(): void {
    if (this.destroyed) return;
    this.downloads.dispose();
    this.lease.takeOver(); this.hide(); this.destroyed = true; this.pendingLoad = undefined; this.frames?.destroy(); this.cancelTool?.(); if (this.loadTimer) clearTimeout(this.loadTimer);
    const contents = this.engine;
    if (this.agentView && !this.host.window.isDestroyed()) this.host.window.contentView.removeChildView(this.agentView);
    if (contents && !contents.isDestroyed()) { if (contents.debugger.isAttached()) contents.debugger.detach(); contents.close({ waitForBeforeUnload: false }); }

  }
}
