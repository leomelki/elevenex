import { BrowserWindow, WebContentsView, session, nativeTheme, dialog, app } from 'electron';
import { createHash } from 'node:crypto';
import type { BackendResult, CodeBounds, CodeOpenFile, CodeSurfaceState, CodeTarget, CodeWindowContext, EnvironmentSelection } from '@elevenex/shared';
import type { BackendClient } from '../backend-client/client';
import { requestBackendJson } from '../backend-client/transport';
import { CodeArtifact } from './artifact';
import { CodeProtocol } from './protocol';
import { descriptor, type WorkspaceDescriptor } from './validation';
interface Surface {
  readonly key: string; readonly environment: EnvironmentSelection; readonly configurationIdentity: string; readonly view: WebContentsView; readonly host: CodeProtocol;
  state: CodeSurfaceState; startup?: ReturnType<typeof setTimeout>; wasReady?: boolean; failedStartup?: boolean; crashed?: boolean; closing?: Promise<boolean>; owner: number; target: CodeTarget; used: number; reconcileExplorer?: boolean;
  parent?: BrowserWindow; detached?: BrowserWindow;
}
const failure = (message: string): BackendResult<never> => ({ ok: false, error: { code: 'unavailable', message } });
/** Application-owned workbenches, one per actual workspace, independent of Angular mounts. */
export class CodeSurfaces {
  private readonly artifact: CodeArtifact;
  private readonly surfaces = new Map<string, Surface>();
  private readonly starting = new Map<string, Promise<Surface>>();
  private readonly active = new Map<number, string>();
  private readonly windowContexts = new Map<number, { context: CodeWindowContext; configurationIdentity: string; storageIdentity?: string; unbound?: boolean; closeAccepted?: boolean }>();
  private readonly offered = new Map<number, { key: string; target: CodeTarget }>();
  private readonly desired = new Map<number, CodeTarget>();
  private readonly lifetime = new AbortController();
  private shutdown?: Promise<void>;
  private readonly themeChanged = () => {
    for (const surface of this.surfaces.values()) if (!surface.view.webContents.isDestroyed()) void surface.view.webContents.executeJavaScript(`import('/assets/out/vs/workbench/workbench.web.main.internal.js').then(({commands}) => commands.executeCommand('elevenex.code.set-theme',${nativeTheme.shouldUseDarkColors}))`).catch(() => undefined);
  };
  constructor(private readonly client: BackendClient, root: string, private readonly fonts: string, private readonly changed: (windowId: number, target: CodeTarget, state: CodeSurfaceState) => void, private readonly exitRequested: (windowId: number, target: CodeTarget) => void = () => undefined, private readonly openEditorWindow?: (context: CodeWindowContext, configurationIdentity: string) => BrowserWindow) {
    this.artifact = new CodeArtifact(root);
    nativeTheme.on('updated', this.themeChanged);
  }
  async open(windowId: number, target: CodeTarget, acceptChange = false): Promise<BackendResult<CodeSurfaceState>> {
    if (this.shutdown || this.lifetime.signal.aborted) return failure('The editor is closing.');
    const desire = { ...target }; this.desired.set(windowId, desire);
    const context = this.windowContexts.get(windowId), initialScope = this.client.state(windowId).scope;
    if (context && target.taskId !== context.context.target.taskId) return failure('This window belongs to another task.');
    if (context && initialScope?.id === target.scopeId && context.configurationIdentity !== this.client.configurationIdentity(windowId, target.scopeId)) { context.unbound = true; return failure('The machine settings changed. Copy retained edits before closing this editor.'); }
    const result = await this.client.execute(windowId, target.scopeId, `code:describe:${target.taskId}`, false, async (endpoint, signal) => descriptor(await requestBackendJson(endpoint, { path: `/api/code-workspaces/${target.taskId}${context?.storageIdentity ? '?taskIncarnation=' + context.storageIdentity : ''}`, conflictMessages: { 'workspace-changed': 'Task identity changed.', 'workspace-unavailable': 'Task workspace is unavailable.' } }, signal), target.taskId));
    if (!result.ok) { if (context && result.error.message === 'Task identity changed.') context.unbound = true; return result; }
    const scope = this.client.state(windowId).scope;
    if (this.desired.get(windowId) !== desire || scope?.id !== target.scopeId) return failure('Code selection changed.');
    const key = createHash('sha256').update(JSON.stringify([scope.environment, this.client.configurationIdentity(windowId, target.scopeId), target.taskId, result.value.storageIdentity])).digest('hex');
    try {
      const assets = await this.artifact.prepare();
      if (this.lifetime.signal.aborted || this.desired.get(windowId) !== desire || this.client.state(windowId).scope?.id !== target.scopeId) return failure('Code selection changed.');
      let surface = this.surfaces.get(key);
      if (surface?.closing) { await surface.closing; surface = this.surfaces.get(key); }
      if (!surface) {
        let pending = this.starting.get(key);
        if (!pending) {
          pending = this.create(key, windowId, target, result.value, assets);
          this.starting.set(key, pending); void pending.finally(() => this.starting.delete(key)).catch(() => undefined);
        }
        surface = await pending;
      }
      if (this.lifetime.signal.aborted || this.desired.get(windowId) !== desire || this.client.state(windowId).scope?.id !== target.scopeId) return failure('Code selection changed.');
      if (surface.owner !== windowId && BrowserWindow.getAllWindows().some(window => window.webContents.id === surface.owner) && !acceptChange && !context) {
        this.offered.set(windowId, { key, target });
        return { ok: true, value: { ...surface.state, relocated: true, detached: !!surface.detached, phase: 'disconnected', message: 'Code is open in another window' } };
      }
      const old = this.surfaces.get(this.active.get(windowId) ?? '');
      if (old && old !== surface && !old.detached) this.hide(old);
      this.active.set(windowId, key);

      if (surface.owner !== windowId) {
        this.hide(surface);
        this.offered.set(surface.owner, { key, target: surface.target });
        this.changed(surface.owner, surface.target, { ...surface.state, relocated: true, detached: !!surface.detached, phase: 'disconnected', message: 'Code moved to another window' });
      }
      surface.owner = windowId; this.offered.delete(windowId); surface.state = { ...surface.state, relocated: false, detached: false };
      if (surface.detached && surface.detached.webContents.id !== windowId) { const detached = surface.detached; surface.detached = undefined; detached.close(); }
      surface.target = target; const rebound = surface.host.bind(target); surface.host.windowId = windowId; surface.host.embedded = !this.windowContexts.has(windowId);
      if (rebound) { surface.reconcileExplorer = true; surface.state = { ...surface.state, phase: 'loading', message: 'Reconnecting task workspace…' }; }
      if (surface.host.workspace.identity !== result.value.identity) {
        if (acceptChange) { surface.host.workspace = result.value; surface.host.reset(); surface.state = { ...surface.state, identity: result.value.identity, phase: 'loading', message: 'Updating workspace · retained edits stay here', recovery: false, recoveryAvailable: false }; }
        else surface.state = { ...surface.state, phase: 'disconnected', message: 'Workspace changed · saves blocked', recovery: true, recoveryAvailable: true };
      }
      if (acceptChange && surface.host.workspace.identity === result.value.identity) surface.state = { ...surface.state, recovery: false, recoveryAvailable: false };
      if (surface.crashed || surface.failedStartup || rebound && !surface.wasReady) { surface.crashed = false; surface.failedStartup = false; surface.host.reset(); surface.state = { ...surface.state, phase: 'loading', message: 'Recovering editor…' }; await surface.view.webContents.loadURL(`https://${surface.host.authority}/`); }
      if (rebound || acceptChange) void surface.view.webContents.executeJavaScript("import('/assets/out/vs/workbench/workbench.web.main.internal.js').then(({commands}) => commands.executeCommand('elevenex.code.reconnect'))").catch(() => undefined);
      surface.used = Date.now(); this.changed(windowId, target, surface.state);
      return { ok: true, value: surface.state };
    } catch (error) { return failure(error instanceof Error ? error.message.slice(0, 300) : 'Editor could not start. Try again.'); }
  }
  layout(windowId: number, target: CodeTarget, bounds: CodeBounds | null): void {
    const surface = this.owned(windowId, target, true);
    if (!surface || surface.detached && surface.detached.webContents.id !== windowId) return;
    if (!bounds || bounds.width < 600 || bounds.height < 160) { this.hide(surface); return; }
    const window = BrowserWindow.fromWebContents(this.ownerContents(windowId));
    if (!window || window.isDestroyed()) return;
    const zoom = window.webContents.getZoomFactor();
    bounds = { x: bounds.x * zoom, y: bounds.y * zoom, width: bounds.width * zoom, height: bounds.height * zoom };
    if (surface.view.webContents.getZoomFactor() !== zoom) surface.view.webContents.setZoomFactor(zoom);
    const [width = 0, height = 0] = window.getContentSize();
    // A native child cannot cover the island/rail/sidebar or leave the sending window.
    if (bounds.x < (this.windowContexts.has(windowId) ? 0 : 56) || bounds.y < 48 || bounds.x + bounds.width > width + 1 || bounds.y + bounds.height > height + 1) { this.hide(surface); return; }
    if (surface.parent !== window) { this.hide(surface); window.contentView.addChildView(surface.view); surface.parent = window; }
    surface.view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.floor(bounds.width), height: Math.floor(bounds.height) });
    surface.host.active = true; surface.view.setVisible(true);
    if (surface.reconcileExplorer) {
      // Upstream Explorer retains failed directory resolutions independently of
      // the filesystem provider. Refresh once the rebound view is actually visible.
      surface.reconcileExplorer = false;
      void surface.view.webContents.executeJavaScript("import('/assets/out/vs/workbench/workbench.web.main.internal.js').then(({commands}) => commands.executeCommand('workbench.files.action.refreshFilesExplorer'))").catch(() => { surface.reconcileExplorer = true; });
    }
  }
  focus(windowId: number, target: CodeTarget): void {
    const offered = this.offered.get(windowId);
    const surface = this.owned(windowId, target, true) ?? (offered?.target.scopeId === target.scopeId && offered.target.taskId === target.taskId ? this.surfaces.get(offered.key) : undefined);
    surface?.parent?.focus(); surface?.view.webContents.focus();
    if (surface) void surface.view.webContents.executeJavaScript("import('/assets/out/vs/workbench/workbench.web.main.internal.js').then(({commands}) => commands.executeCommand('workbench.action.focusActiveEditorGroup'))").catch(() => undefined);
  }
  async openFile(windowId: number, target: CodeTarget, file: CodeOpenFile): Promise<BackendResult<{ readonly accepted: true }>> {
    const current = await this.open(windowId, target, true); if (!current.ok) return current;
    const surface = this.owned(windowId, target);
    if (!surface || this.client.state(windowId).scope?.id !== target.scopeId) return failure('Open Code for the current task first.');
    if (!await surface.host.whenReady()) return failure('Editor is still opening. Try opening the file again.');
    if (this.client.state(windowId).scope?.id !== target.scopeId) return failure('Code selection changed.');
    try {
      // Fixed named upstream embedder operation. No caller-supplied program or
      // general evaluator crosses IPC; the URI is validated task-relative data.
      await surface.view.webContents.executeJavaScript(`import('/assets/out/vs/workbench/workbench.web.main.internal.js').then(({commands}) => commands.executeCommand('elevenex.code.open-file',${JSON.stringify(file.path)},${file.line ?? 1},${file.column ?? 1}))`);
      if (this.client.state(windowId).scope?.id !== target.scopeId || surface.owner !== windowId) return failure('Code selection changed.');
      return { ok: true, value: { accepted: true } };
    } catch { return failure('File could not open. Check the task connection and try again.'); }
  }
  recover(windowId: number, target: CodeTarget): Promise<BackendResult<CodeSurfaceState>> {
    // Explicit acceptance revalidates the task before rebinding its transport.
    // Durable per-file generations still block old buffers until comparison.
    return this.open(windowId, target, true);
  }
  registerWindow(windowId: number, context: CodeWindowContext, configurationIdentity: string): void { const surface = [...this.surfaces.values()].find(surface => surface.target.taskId === context.target.taskId && surface.configurationIdentity === configurationIdentity && surface.state.identity === context.state.identity); this.windowContexts.set(windowId, { context, configurationIdentity, ...(surface ? { storageIdentity: surface.host.workspace.storageIdentity } : {}) }); }
  windowContext(windowId: number): CodeWindowContext | null { const context = this.windowContexts.get(windowId)?.context; if (!context) return null; const surface = this.surfaces.get(this.active.get(windowId) ?? ''); return surface ? { ...context, target: surface.target, state: surface.state } : context; }
  detach(windowId: number, target: CodeTarget): void {
    const surface = this.owned(windowId, target, true);
    if (!surface) return;
    if (surface.detached) { surface.detached.show(); surface.detached.focus(); return; }
    if (!this.openEditorWindow) throw new Error('Editor windows require the desktop host.');
    const context: CodeWindowContext = { target, state: { ...surface.state, detached: false, relocated: false }, selection: surface.environment, machineName: surface.environment.kind === 'local' ? 'This machine' : 'Remote machine' };
    const window = this.openEditorWindow(context, surface.configurationIdentity), nextId = window.webContents.id;
    this.hide(surface); this.active.delete(windowId); this.offered.set(windowId, { key: surface.key, target });
    this.changed(windowId, target, { ...surface.state, detached: true, relocated: true, phase: 'disconnected', message: 'Code is open in its own window' });
    surface.owner = nextId; surface.target = target; surface.detached = window; surface.host.embedded = false; surface.state = { ...surface.state, detached: false, relocated: false };
    this.active.set(nextId, surface.key);
    let confirming = false;
    window.on('close', event => { if (surface.detached !== window) return; const record = this.windowContexts.get(nextId); if (record?.unbound && surface.host.dirty && !record.closeAccepted) { event.preventDefault(); if (!confirming) { confirming = true; void dialog.showMessageBox(window, { type: 'warning', message: 'Copy retained edits before closing', detail: 'This editor belongs to previous task or machine settings. Copy any unsaved text before closing it.', buttons: ['Keep open', 'Close editor'], defaultId: 0, cancelId: 0 }).then(result => { confirming = false; if (result.response === 1 && !window.isDestroyed()) { record.closeAccepted = true; window.close(); } }); } return; } this.hide(surface); surface.detached = undefined; for (const [id, offered] of this.offered) if (offered.key === surface.key) this.changed(id, offered.target, { ...surface.state, relocated: true, phase: 'disconnected', message: 'Editor retained · open it here' }); });
  }
  release(windowId: number, target: CodeTarget): void {
    this.client.cancel(windowId, target.scopeId, `code:describe:${target.taskId}`);
    const desire = this.desired.get(windowId);
    if (desire?.scopeId === target.scopeId && desire.taskId === target.taskId) this.desired.delete(windowId);
    const surface = this.owned(windowId, target);
    if (surface && !surface.detached) this.hide(surface);
  }
  releaseWindow(windowId: number, cleanup: () => void): void {
    this.active.delete(windowId); this.windowContexts.delete(windowId); this.offered.delete(windowId); cleanup();
  }
  detachWindow(windowId: number): void {
    this.desired.delete(windowId);
    for (const surface of this.surfaces.values()) if (surface.owner === windowId && !surface.detached) this.hide(surface);
  }
  dispose(): Promise<void> {
    return this.shutdown ??= this.closeAll().catch(error => { this.shutdown = undefined; throw error; });
  }
  private async closeAll(): Promise<void> {
    for (const surface of this.surfaces.values()) {
      if (this.windowContexts.get(surface.owner)?.unbound && surface.host.dirty && !this.windowContexts.get(surface.owner)?.closeAccepted) throw new Error('Copy retained editor text before quitting because the task or machine settings changed.');
      clearTimeout(surface.startup);
      if (!await this.closeWorkbench(surface)) throw new Error('Editor backups could not finish. Copy your unsaved text and free application storage before quitting.');
      surface.detached?.destroy();
    }
    nativeTheme.removeListener('updated', this.themeChanged);
    this.lifetime.abort(); await this.artifact.dispose();
    this.surfaces.clear(); this.desired.clear(); this.active.clear(); this.windowContexts.clear(); this.offered.clear();
  }
  private closeWorkbench(surface: Surface): Promise<boolean> {
    return surface.closing ??= this.closeWorkbenchWhenReady(surface).finally(() => { surface.closing = undefined; });
  }
  private async closeWorkbenchWhenReady(surface: Surface): Promise<boolean> {
    // Respect upstream's beforeUnload veto until hot-exit backups are current.
    // Never evict a live view merely because a cached dirty count says zero.
    for (let attempt = 0; attempt < 40; attempt++) {
      if (surface.view.webContents.isDestroyed()) return true;
      surface.view.webContents.close({ waitForBeforeUnload: true });
      const closed = await new Promise<boolean>(resolve => {
        const done = () => { clearTimeout(timer); resolve(true); };
        const timer = setTimeout(() => { surface.view.webContents.removeListener('destroyed', done); resolve(false); }, 200);
        surface.view.webContents.once('destroyed', done);
      });
      if (closed) return true;
    }
    return surface.view.webContents.isDestroyed();
  }
  private async create(key: string, windowId: number, target: CodeTarget, workspace: WorkspaceDescriptor, assets: string): Promise<Surface> {
    if (this.surfaces.size + this.starting.size >= 4) {
      const clean = [...this.surfaces.values()].filter(s => s.wasReady && !s.host.dirty && !s.parent && !s.detached).sort((a, b) => a.used - b.used)[0];
      if (!clean) throw new Error('Four editors are retained. Save and close an editor before opening another task.');
      if (!await this.closeWorkbench(clean)) throw new Error('A retained editor still needs to back up its changes. Save that editor before opening another.');
    }
    this.lifetime.signal.throwIfAborted();
    if (this.client.state(windowId).scope?.id !== target.scopeId) throw new Error('Machine changed during editor setup. Reopen Code.');
    const creatingScope = this.client.state(windowId).scope; if (creatingScope?.id !== target.scopeId) throw new Error('Machine disconnected.');
    const environment = creatingScope.environment;
    const editorSession = session.fromPartition('persist:elevenex-code-' + key, { cache: false });
    const state: CodeSurfaceState = { taskName: workspace.name, branch: workspace.branch, taskId: workspace.taskId, identity: workspace.identity, phase: 'loading', message: 'Opening task workspace…' };
    const host = new CodeProtocol(editorSession, this.client, windowId, target, workspace, assets, this.fonts, () => nativeTheme.shouldUseDarkColors, (phase, message) => {
      const surface = this.surfaces.get(key);
      if (!surface) return;
      if (phase === 'ready') { surface.wasReady = true; clearTimeout(surface.startup); surface.startup = undefined; }
      if (message === 'Workspace changed · saves blocked') surface.state = { ...surface.state, recovery: true, recoveryAvailable: true };
      if (surface.state.phase === phase && surface.state.message === message && surface.state.taskName === host.workspace.name && surface.state.branch === host.workspace.branch) return;
      surface.detached?.setTitle('Code · ' + host.workspace.name);
      surface.state = { ...surface.state, taskName: host.workspace.name, branch: host.workspace.branch, phase: surface.state.recovery ? 'disconnected' : phase, message: surface.state.recovery ? 'Workspace changed · saves blocked' : message }; if (this.active.get(surface.owner) !== key) return; this.changed(surface.owner, surface.target, surface.state);
    }, () => { const surface = this.surfaces.get(key); if (surface && !surface.detached && this.active.get(surface.owner) === key) this.exitRequested(surface.owner, surface.target); });
    await host.register();
    if (this.lifetime.signal.aborted || this.client.state(windowId).scope?.id !== target.scopeId) { host.dispose(); throw new Error('The editor selection changed. Reopen Code.'); }
    const view = new WebContentsView({ webPreferences: { session: editorSession, sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: !app.isPackaged } });
    view.setBounds({ x: 0, y: 0, width: 900, height: 600 });
    view.setVisible(false);
    const surface: Surface = { key, environment, configurationIdentity: this.client.configurationIdentity(windowId, target.scopeId) ?? '', view, host, state, owner: windowId, target, used: Date.now() };
    this.surfaces.set(key, surface);
    surface.startup = setTimeout(() => { if (surface.wasReady || this.lifetime.signal.aborted) return; surface.failedStartup = true; surface.state = { ...surface.state, phase: 'failed', message: 'Editor did not become ready. Check the connection and recover the editor.' }; this.changed(surface.owner, surface.target, surface.state); }, 30_000);
    view.webContents.once('destroyed', () => { clearTimeout(surface.startup); this.hide(surface); host.dispose(); void editorSession.clearCodeCaches({}).catch(() => undefined); if (this.surfaces.get(key) === surface) this.surfaces.delete(key); });
    view.webContents.on('before-input-event', (event, input) => {
      if (!surface.detached && input.type === 'keyDown' && !input.isAutoRepeat && (input.meta || input.control) && input.shift && input.key.toLowerCase() === 'r') { event.preventDefault(); this.exitRequested(surface.owner, surface.target); }
    });
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', (event, url) => { if (url !== `https://${host.authority}/`) event.preventDefault(); });
    view.webContents.on('will-redirect', event => event.preventDefault());
    view.webContents.on('will-attach-webview', event => event.preventDefault());
    view.webContents.on('render-process-gone', () => { surface.crashed = true; surface.host.reset(); this.hide(surface); surface.state = { ...surface.state, phase: 'failed', message: 'Editor stopped. Reopen Code to recover retained buffers.' }; this.changed(surface.owner, surface.target, surface.state); });
    try { await view.webContents.loadURL(`https://${host.authority}/`); } catch { surface.failedStartup = true; surface.state = { ...surface.state, phase: 'failed', message: 'Editor could not load. Recover Code to try again.' }; this.changed(surface.owner, surface.target, surface.state); throw new Error('Editor could not load. Recover Code to try again.'); }
    return surface;
  }
  private owned(windowId: number, target: CodeTarget, cachedDisplay = false): Surface | undefined {
    const surface = this.surfaces.get(this.active.get(windowId) ?? '');
    return surface?.owner === windowId && surface.target.taskId === target.taskId && (surface.target.scopeId === target.scopeId || cachedDisplay && this.windowContexts.get(windowId)?.context.target.taskId === target.taskId) ? surface : undefined;
  }
  private hide(surface: Surface): void {
    surface.host.active = false; surface.view.setVisible(false);
    if (surface.parent && !surface.parent.isDestroyed()) surface.parent.contentView.removeChildView(surface.view);
    surface.parent = undefined;
  }
  private ownerContents(windowId: number) {
    const window = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents.id === windowId);
    if (!window) throw new Error('Editor window closed');
    return window.webContents;
  }
}
