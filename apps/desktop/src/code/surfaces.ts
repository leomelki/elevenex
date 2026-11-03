import { BrowserWindow, nativeTheme, dialog, type WebContents } from 'electron';
import { createHash } from 'node:crypto';
import type { BackendResult, CodeAction, CodeBounds, CodePresentation, CodeOpenFile, CodeSurfaceState, CodeTarget, CodeWindowContext, EnvironmentSelection } from '@elevenex/shared';
import type { BackendClient } from '../backend-client/client';
import { requestBackendJson } from '../backend-client/transport';
import { CodeArtifact } from './artifact';
import { CodeProtocol } from './protocol';
import { CodeFrame } from './frame';
import { CodeFrameRouter } from './frame-router';
import { descriptor, type WorkspaceDescriptor } from './validation';
interface Surface {
  readonly key: string; readonly environment: EnvironmentSelection; readonly configurationIdentity: string; readonly frame: CodeFrame; readonly host: CodeProtocol;
  state: CodeSurfaceState; startup?: ReturnType<typeof setTimeout>; wasReady?: boolean; failedStartup?: boolean; crashed?: boolean; closing?: Promise<boolean>; owner: number; target: CodeTarget; used: number; reconcileExplorer?: boolean; layoutRevision?: number; compact?: boolean; presentation?: Promise<unknown>;
  visible?: boolean; detached?: BrowserWindow;
}
const failure = (message: string): BackendResult<never> => ({ ok: false, error: { code: 'unavailable', message } });
/** Application-owned task leases. DOM-owned frames are retained across Angular mounts. */
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
  private router?: CodeFrameRouter;
  private readonly themeChanged = () => {
    for (const surface of this.surfaces.values()) if (surface.frame.current()) void surface.frame.command('elevenex.code.set-theme', nativeTheme.shouldUseDarkColors).catch(() => undefined);
  };
  constructor(private readonly client: BackendClient, root: string, private readonly fonts: string, private readonly changed: (windowId: number, target: CodeTarget, state: CodeSurfaceState) => void, private readonly exitRequested: (windowId: number, target: CodeTarget) => void = () => undefined, private readonly openEditorWindow?: (context: CodeWindowContext, configurationIdentity: string) => BrowserWindow, private readonly shellOrigin = 'app://elevenex') {
    this.artifact = new CodeArtifact(root);
    nativeTheme.on('updated', this.themeChanged);
  }
  attachWindow(contents: WebContents, devUrl?: string): () => void {
    this.router ??= new CodeFrameRouter(contents.session, devUrl);
    const stopRouting = this.router.attach(contents);
    const failed = () => {
      for (const surface of this.surfaces.values()) if (surface.owner === contents.id) {
        surface.crashed = true; surface.wasReady = false; surface.host.reset(); this.hide(surface);
        surface.state = { ...surface.state, phase: 'failed', message: 'Editor stopped. Reopen Code to recover retained buffers.' };
        this.changed(surface.owner, surface.target, surface.state);
      }
    };
    contents.on('render-process-gone', failed);
    return () => { stopRouting(); contents.removeListener('render-process-gone', failed); };
  }
  async prepareWindowClose(windowId: number): Promise<boolean> {
    const window = BrowserWindow.fromWebContents(this.ownerContents(windowId));
    const record = this.windowContexts.get(windowId);
    if (record?.unbound && !record.closeAccepted && [...this.surfaces.values()].some(surface => surface.owner === windowId && surface.host.dirty)) {
      if (!window) return false;
      const result = await dialog.showMessageBox(window, { type: 'warning', message: 'Copy retained edits before closing', detail: 'This editor belongs to previous task or machine settings. Copy any unsaved text before closing it.', buttons: ['Keep open', 'Close editor'], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return false;
      record.closeAccepted = true;
    }
    for (const surface of this.surfaces.values()) if (surface.owner === windowId) {
      if (!await surface.frame.close()) {
        if (window && !window.isDestroyed()) await dialog.showMessageBox(window, { type: 'warning', message: 'Editor changes are still backing up', detail: 'Your editor stays open. Try closing again after the backup finishes.', buttons: ['Keep open'] });
        return false;
      }
      surface.wasReady = false; surface.host.reset(); surface.compact = undefined;
      surface.state = { ...surface.state, phase: 'loading', message: 'Restoring retained editor…' };
    }
    return true;
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
        if (!await surface.frame.close()) return failure('Editor backups are still pending. Try again after they finish.');
        surface.host.reset(); surface.wasReady = false; surface.compact = undefined;
        surface.state = { ...surface.state, phase: 'loading', message: 'Restoring your editor…' }; this.armStartup(surface);
        this.hide(surface);
        this.offered.set(surface.owner, { key, target: surface.target });
        this.changed(surface.owner, surface.target, { ...surface.state, relocated: true, detached: !!surface.detached, phase: 'disconnected', message: 'Code moved to another window' });
      }
      surface.owner = windowId; surface.frame.windowId = windowId; this.offered.delete(windowId); surface.state = { ...surface.state, relocated: false, detached: false };
      if (surface.detached && surface.detached.webContents.id !== windowId) { const detached = surface.detached; surface.detached = undefined; detached.close(); }
      surface.target = target; const rebound = surface.host.bind(target); surface.host.windowId = windowId; surface.host.embedded = !this.windowContexts.has(windowId);
      if (rebound) { surface.reconcileExplorer = true; surface.state = { ...surface.state, phase: 'loading', message: 'Reconnecting task workspace…' }; }
      if (surface.host.workspace.identity !== result.value.identity) {
        if (acceptChange) { surface.host.workspace = result.value; surface.host.reset(); surface.state = { ...surface.state, identity: result.value.identity, phase: 'loading', message: 'Updating workspace · retained edits stay here', recovery: false, recoveryAvailable: false }; }
        else surface.state = { ...surface.state, phase: 'disconnected', message: 'Workspace changed · saves blocked', recovery: true, recoveryAvailable: true };
      }
      if (acceptChange && surface.host.workspace.identity === result.value.identity) surface.state = { ...surface.state, recovery: false, recoveryAvailable: false };
      if (surface.crashed || surface.failedStartup || rebound && !surface.wasReady) { surface.crashed = false; surface.failedStartup = false; surface.compact = undefined; surface.host.reset(); surface.state = { ...surface.state, phase: 'loading', message: 'Recovering editor…' }; this.armStartup(surface); await surface.frame.reload(); }
      if (rebound || acceptChange) void surface.frame.command('elevenex.code.reconnect').catch(() => undefined);
      surface.used = Date.now(); this.changed(windowId, target, surface.state);
      return { ok: true, value: surface.state };
    } catch (error) { return failure(error instanceof Error ? error.message.slice(0, 300) : 'Editor could not start. Try again.'); }
  }
  async layout(windowId: number, target: CodeTarget, bounds: CodeBounds | null): Promise<void> {
    // Compatibility for existing desktop consumers; native geometry is retired.
    return this.present(windowId, target, { visible: !!bounds && bounds.width >= 320 && bounds.height >= 160, compact: !!bounds && bounds.width < 600 });
  }
  async present(windowId: number, target: CodeTarget, presentation: CodePresentation): Promise<void> {
    const surface = this.owned(windowId, target, true);
    if (!surface || surface.detached && surface.detached.webContents.id !== windowId) return;
    if (!presentation.visible) { this.hide(surface); return; }
    const compact = presentation.compact;
    const revision = surface.layoutRevision = (surface.layoutRevision ?? 0) + 1;
    if (surface.compact !== compact && surface.wasReady) {
      surface.compact = compact;
      surface.presentation = (surface.presentation ?? Promise.resolve()).catch(() => undefined).then(() => surface.frame.command('elevenex.code.set-compact', compact));
    }
    try { await surface.presentation; } catch { surface.compact = undefined; return; }
    if (revision !== surface.layoutRevision || this.owned(windowId, target, true) !== surface) return;
    surface.host.active = true; surface.visible = true;
    if (surface.reconcileExplorer) {
      surface.reconcileExplorer = false;
      void surface.frame.command('workbench.files.action.refreshFilesExplorer').catch(() => { surface.reconcileExplorer = true; });
    }
  }
  async action(windowId: number, target: CodeTarget, action: CodeAction): Promise<void> {
    const surface = this.owned(windowId, target);
    if (!surface || this.client.state(windowId).scope?.id !== target.scopeId || !surface.host.active || !surface.visible) throw new Error('The current task editor is not visible.');
    const commands = { 'find-file': 'workbench.action.quickOpen', 'search-text': 'workbench.action.quickTextSearch', save: 'workbench.action.files.save' } as const;
    this.ownerContents(windowId).focus(); await surface.frame.focus();
    if (this.owned(windowId, target) !== surface || this.client.state(windowId).scope?.id !== target.scopeId || !surface.host.active || !surface.visible) throw new Error('Code selection changed.');
    await surface.frame.command(commands[action]);
  }
  async focus(windowId: number, target: CodeTarget): Promise<void> {
    const offered = this.offered.get(windowId);
    const surface = this.owned(windowId, target, true) ?? (offered?.target.scopeId === target.scopeId && offered.target.taskId === target.taskId ? this.surfaces.get(offered.key) : undefined);
    if (surface) { BrowserWindow.fromWebContents(this.ownerContents(surface.owner))?.focus(); await surface.frame.focus(); }
  }
  async openFile(windowId: number, target: CodeTarget, file: CodeOpenFile): Promise<BackendResult<{ readonly accepted: true }>> {
    const current = await this.open(windowId, target, true); if (!current.ok) return current;
    const surface = this.owned(windowId, target);
    if (!surface || this.client.state(windowId).scope?.id !== target.scopeId) return failure('Open Code for the current task first.');
    if (!await surface.host.whenReady()) return failure('Editor is still opening. Try opening the file again.');
    if (this.client.state(windowId).scope?.id !== target.scopeId || this.owned(windowId, target) !== surface) return failure('Code selection changed.');
    try {
      // Fixed named upstream embedder operation. No caller-supplied program or
      // general evaluator crosses IPC; the URI is validated task-relative data.
      await surface.frame.command('elevenex.code.open-file', file.path, file.line ?? 1, file.column ?? 1);
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
  async detach(windowId: number, target: CodeTarget): Promise<void> {
    const surface = this.owned(windowId, target, true);
    if (!surface) return;
    if (surface.detached) { surface.detached.show(); surface.detached.focus(); return; }
    if (!this.openEditorWindow) throw new Error('Editor windows require the desktop host.');
    if (!await surface.frame.close()) throw new Error('Editor backups are still pending. Your editor stays here.');
    if (this.owned(windowId, target, true) !== surface) throw new Error('Code selection changed. Reopen the editor to restore its writing.');
    surface.host.reset(); surface.wasReady = false; surface.compact = undefined;
    surface.state = { ...surface.state, phase: 'loading', message: 'Restoring your editor…' }; this.armStartup(surface);
    const context: CodeWindowContext = { target, state: { ...surface.state, detached: false, relocated: false }, selection: surface.environment, machineName: surface.environment.kind === 'local' ? 'This machine' : 'Remote machine' };
    const window = this.openEditorWindow(context, surface.configurationIdentity), nextId = window.webContents.id;
    this.hide(surface); this.active.delete(windowId); this.offered.set(windowId, { key: surface.key, target });
    this.changed(windowId, target, { ...surface.state, detached: true, relocated: true, phase: 'disconnected', message: 'Code is open in its own window' });
    surface.owner = nextId; surface.frame.windowId = nextId; surface.target = target; surface.detached = window; surface.host.embedded = false; surface.host.windowId = nextId; surface.state = { ...surface.state, detached: false, relocated: false };
    this.active.set(nextId, surface.key);
    window.on('closed', () => {
      if (surface.detached !== window) return;
      this.hide(surface); surface.detached = undefined;
      for (const [id, offered] of this.offered) if (offered.key === surface.key) this.changed(id, offered.target, { ...surface.state, relocated: true, phase: 'disconnected', message: 'Editor retained · open it here' });
    });
  }
  release(windowId: number, target: CodeTarget): void {
    this.client.cancel(windowId, target.scopeId, `code:describe:${target.taskId}`);
    const desire = this.desired.get(windowId);
    if (desire?.scopeId === target.scopeId && desire.taskId === target.taskId) this.desired.delete(windowId);
    const surface = this.owned(windowId, target);
    if (surface && !surface.detached) this.hide(surface);
  }
  releaseWindow(windowId: number, cleanup: () => void): void {
    this.active.delete(windowId); this.windowContexts.delete(windowId); this.offered.delete(windowId);
    for (const surface of this.surfaces.values()) if (surface.owner === windowId) { surface.wasReady = false; surface.host.reset(); surface.state = { ...surface.state, phase: 'loading', message: 'Restoring retained editor…' }; }
    cleanup();
  }
  detachWindow(windowId: number): void {
    this.desired.delete(windowId);
    for (const surface of this.surfaces.values()) if (surface.owner === windowId && !surface.detached) {
      this.hide(surface); surface.wasReady = false; surface.compact = undefined; surface.host.reset();
      if (!surface.crashed) surface.state = { ...surface.state, phase: 'loading', message: 'Restoring retained editor…' };
    }
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
    this.lifetime.abort(); await this.artifact.dispose(); this.router?.dispose();
    this.surfaces.clear(); this.desired.clear(); this.active.clear(); this.windowContexts.clear(); this.offered.clear();
  }
  private closeWorkbench(surface: Surface): Promise<boolean> {
    return surface.closing ??= this.closeWorkbenchWhenReady(surface).finally(() => { surface.closing = undefined; });
  }
  private async closeWorkbenchWhenReady(surface: Surface): Promise<boolean> {
    if (!await surface.frame.close()) return false;
    clearTimeout(surface.startup); surface.host.dispose(); this.router?.remove(surface.host);
    this.surfaces.delete(surface.key); return true;
  }
  private async create(key: string, windowId: number, target: CodeTarget, workspace: WorkspaceDescriptor, assets: string): Promise<Surface> {
    if (this.surfaces.size + this.starting.size >= 4) {
      const liveOwners = new Set(BrowserWindow.getAllWindows().map(window => window.webContents.id));
      const clean = [...this.surfaces.values()].filter(s => (s.wasReady || !liveOwners.has(s.owner)) && !s.host.dirty && !s.visible && !s.detached).sort((a, b) => a.used - b.used)[0];
      if (!clean) throw new Error('Four editors are retained. Save and close an editor before opening another task.');
      if (!await this.closeWorkbench(clean)) throw new Error('A retained editor still needs to back up its changes. Save that editor before opening another.');
    }
    this.lifetime.signal.throwIfAborted();
    if (this.client.state(windowId).scope?.id !== target.scopeId) throw new Error('Machine changed during editor setup. Reopen Code.');
    const creatingScope = this.client.state(windowId).scope; if (creatingScope?.id !== target.scopeId) throw new Error('Machine disconnected.');
    const environment = creatingScope.environment;
    const state: CodeSurfaceState = { taskName: workspace.name, branch: workspace.branch, taskId: workspace.taskId, identity: workspace.identity, phase: 'loading', message: 'Opening task workspace…' };
    const host = new CodeProtocol(this.client, windowId, target, workspace, assets, this.fonts, () => nativeTheme.shouldUseDarkColors, (phase, message) => {
      const surface = this.surfaces.get(key);
      if (!surface) return;
      if (phase === 'ready') { surface.wasReady = true; clearTimeout(surface.startup); surface.startup = undefined; }
      if (message === 'Workspace changed · saves blocked') surface.state = { ...surface.state, recovery: true, recoveryAvailable: true };
      if (surface.state.phase === phase && surface.state.message === message && surface.state.taskName === host.workspace.name && surface.state.branch === host.workspace.branch) return;
      surface.detached?.setTitle('Code · ' + host.workspace.name);
      surface.state = { ...surface.state, taskName: host.workspace.name, branch: host.workspace.branch, phase: surface.state.recovery ? 'disconnected' : phase, message: surface.state.recovery ? 'Workspace changed · saves blocked' : message }; if (this.active.get(surface.owner) !== key) return; this.changed(surface.owner, surface.target, surface.state);
    }, () => { const surface = this.surfaces.get(key); if (surface && !surface.detached && this.active.get(surface.owner) === key) this.exitRequested(surface.owner, surface.target); }, this.shellOrigin, key);
    this.router?.add(host);
    const frame = new CodeFrame(windowId, `https://${host.authority}/`);
    const surface: Surface = { key, environment, configurationIdentity: this.client.configurationIdentity(windowId, target.scopeId) ?? '', frame, host, state: { ...state, frameUrl: frame.url }, owner: windowId, target, used: Date.now() };
    this.surfaces.set(key, surface);
    this.armStartup(surface);
    return surface;
  }
  private armStartup(surface: Surface): void {
    clearTimeout(surface.startup);
    surface.startup = setTimeout(() => { if (surface.wasReady || this.lifetime.signal.aborted) return; surface.failedStartup = true; surface.state = { ...surface.state, phase: 'failed', message: 'Editor did not become ready. Check the connection and recover the editor.' }; this.changed(surface.owner, surface.target, surface.state); }, 30_000);
  }
  private owned(windowId: number, target: CodeTarget, cachedDisplay = false): Surface | undefined {
    const surface = this.surfaces.get(this.active.get(windowId) ?? '');
    return surface?.owner === windowId && surface.target.taskId === target.taskId && (surface.target.scopeId === target.scopeId || cachedDisplay && this.windowContexts.get(windowId)?.context.target.taskId === target.taskId) ? surface : undefined;
  }
  private hide(surface: Surface): void {
    surface.layoutRevision = (surface.layoutRevision ?? 0) + 1;
    surface.host.active = false; surface.visible = false;
  }
  private ownerContents(windowId: number) {
    const window = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents.id === windowId);
    if (!window) throw new Error('Editor window closed');
    return window.webContents;
  }
}
