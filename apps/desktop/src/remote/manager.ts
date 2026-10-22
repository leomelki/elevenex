import { randomUUID } from 'node:crypto';
import type { BackendStatus, EnvironmentContext, EnvironmentSelection, EnvironmentSnapshot, RemoteForward, RemoteForwardInput, RemoteHost, RemoteHostInput } from '@elevenex/shared';
import { RemoteConnection, disconnected, type ConnectionOptions } from './connection';
import { RemoteSettingsStore, emptyContext, emptyWindow, environmentKey, type RemoteSettings, type SavedWindow } from './store';
import type { RemoteTransport } from './bootstrap';
import * as validate from './validation';

interface WindowForward {
  status: RemoteForward;
  generation: number;
  running?: Awaited<ReturnType<RemoteTransport['forward']>>;
  available?: boolean;
}
interface WindowState {
  readonly saved: SavedWindow;
  intent: 'connected' | 'paused' | 'disconnected';
  revision: number;
  readonly forwards: Map<string, WindowForward>;
}
export interface RemoteManagerOptions extends Omit<ConnectionOptions, 'host' | 'changed'> { readonly settingsPath: string }

/** Application-scoped registry; connection and forwarding leases belong to windows. */
export class RemoteManager {
  private settings: RemoteSettings = { hosts: [], windows: [] };
  private readonly windows = new Map<number, WindowState>();
  private readonly connections = new Map<string, RemoteConnection>();
  private readonly listeners = new Set<(windowId: number, snapshot: EnvironmentSnapshot) => void>();
  private readonly store: RemoteSettingsStore;
  private readonly fileGrants = { identity: new Set<string>(), config: new Set<string>() };
  private error: Error | undefined;
  private disposed = false;
  private shutdown: Promise<void> | undefined;
  constructor(private readonly options: RemoteManagerOptions) { this.store = new RemoteSettingsStore(options.settingsPath); }

  async load(): Promise<void> {
    try {
      this.settings = await this.store.load();
      for (const host of this.settings.hosts) {
        if (host.identityFile) this.fileGrants.identity.add(host.identityFile);
        if (host.configFile) this.fileGrants.config.add(host.configFile);
      }
    }
    catch (error) { this.error = error instanceof Error ? error : new Error('Remote settings unavailable'); }
  }
  hosts(): readonly RemoteHost[] { this.assertWritable(); return structuredClone(this.settings.hosts); }
  /** Called only after a main-process native file selection, never with IPC paths. */
  grantFile(kind: 'identity' | 'config', path: string): void { this.assertWritable(); this.fileGrants[kind].add(path); }
  subscribe(listener: (windowId: number, snapshot: EnvironmentSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  attach(windowId: number): void {
    if (this.disposed || this.windows.has(windowId)) return;
    if (this.windows.size >= 32) throw new Error('Too many desktop windows');
    const occupied = new Set([...this.windows.values()].map(value => value.saved));
    const saved = this.settings.windows.find(value => !occupied.has(value)) ?? emptyWindow();
    if (!this.settings.windows.includes(saved)) {
      if (this.settings.windows.length >= 32) throw new Error('Too many saved desktop windows');
      this.settings.windows.push(saved);
    }
    this.windows.set(windowId, { saved, intent: saved.connect ? 'connected' : 'disconnected', revision: 0, forwards: new Map() });
    // Launch restoration is deliberately noninteractive. Unknown trust or a
    // locked key pauses rather than presenting a background credential dialog.
    if (saved.connect && saved.selection.kind === 'remote') this.connection(saved.selection.hostId).acquire(windowId, false);
    this.changed();
  }
  async detach(windowId: number): Promise<void> {
    const window = this.windows.get(windowId); if (!window) return;
    this.windows.delete(windowId);
    await this.closeForwards(window);
    if (window.saved.selection.kind === 'remote') await this.connections.get(window.saved.selection.hostId)?.release(windowId);
  }
  snapshot(windowId: number): EnvironmentSnapshot {
    const window = this.window(windowId);
    const selection = window.saved.selection;
    const connection = selection.kind === 'remote' ? this.connections.get(selection.hostId) : undefined;
    let status = selection.kind === 'remote' ? connection?.snapshot() ?? disconnected(selection.hostId) : null;
    if (status && window.intent !== 'connected') status = { ...status, phase: window.intent === 'paused' ? 'paused' : 'disconnected', transport: 'closed', application: 'unknown', retryAt: null };
    return structuredClone({ selection, context: window.saved.contexts[environmentKey(selection)] ?? emptyContext(), connection: status,
      challenge: window.intent === 'connected' ? connection?.challengeFor(windowId) ?? null : null,
      forwards: selection.kind === 'remote' ? this.forwardInputs(window).map(input => window.forwards.get(input.id)?.status ?? { ...input, phase: 'waiting', boundPort: null, message: null }) : [],
    });
  }
  backendStatus(windowId: number, local: BackendStatus): BackendStatus {
    const window = this.window(windowId);
    if (window.saved.selection.kind === 'local') return local;
    const connection = this.connections.get(window.saved.selection.hostId);
    const url = window.intent === 'connected' ? connection?.backendUrl() : undefined;
    const status = connection?.snapshot();
    if (url && this.remoteVersion) return { phase: 'ready', url, version: this.remoteVersion };
    return { phase: 'failed', version: this.remoteVersion ?? null, message: status?.failure?.message ?? 'Remote environment is not ready. Connect or retry before using its backend.' };
  }
  private remoteVersion: string | undefined;
  /** Main-process domain adapters only; this capability is never registered as IPC. */
  backendAccess(windowId: number): { readonly url: string; readonly headers: Readonly<Record<string, string>> } | null {
    const window = this.window(windowId);
    if (window.intent !== 'connected' || window.saved.selection.kind !== 'remote') return null;
    const connection = this.connections.get(window.saved.selection.hostId);
    const url = connection?.backendUrl();
    return url && connection ? { url, headers: connection.backendHeaders() } : null;
  }

  async saveHost(input: RemoteHostInput, hostId: string | null): Promise<RemoteHost> {
    this.assertWritable(); const validated = validate.hostInput(input);
    if (validated.identityFile && !this.fileGrants.identity.has(validated.identityFile)) throw new Error('Choose the identity file with the desktop file picker first');
    if (validated.configFile && !this.fileGrants.config.has(validated.configFile)) throw new Error('Choose the SSH config file with the desktop file picker first');
    const current = hostId === null ? undefined : this.settings.hosts.find(host => host.id === validate.id(hostId));
    if (hostId !== null && !current) throw new Error('Unknown saved host');
    if (current && this.connections.get(current.id)?.active) throw new Error('Disconnect this host in every window before editing its shared settings');
    if (!current && this.settings.hosts.length >= 100) throw new Error('Saved host limit reached');
    const host = { ...validated, id: current?.id ?? randomUUID() };
    if (current) { this.settings.hosts.splice(this.settings.hosts.indexOf(current), 1, host); await this.connections.get(host.id)?.dispose(); this.connections.delete(host.id); }
    else this.settings.hosts.push(host);
    await this.save(); this.changed(); return { ...host };
  }
  async removeHost(hostId: string): Promise<void> {
    this.assertWritable(); validate.id(hostId);
    if (this.connections.get(hostId)?.active) throw new Error('Disconnect this host in every window before removing it');
    if (!this.settings.hosts.some(host => host.id === hostId)) throw new Error('Unknown saved host');
    this.settings.hosts = this.settings.hosts.filter(host => host.id !== hostId);
    await this.connections.get(hostId)?.dispose(); this.connections.delete(hostId);
    for (const window of this.settings.windows) {
      delete window.contexts[hostId]; delete window.forwards[hostId];
      if (window.selection.kind === 'remote' && window.selection.hostId === hostId) { window.selection = { kind: 'local' }; window.connect = false; }
    }
    await this.save(); this.changed();
  }
  async select(windowId: number, input: EnvironmentSelection): Promise<EnvironmentSnapshot> {
    this.assertWritable(); const next = validate.selection(input); const window = this.window(windowId);
    const revision = ++window.revision;
    if (next.kind === 'remote' && !this.settings.hosts.some(host => host.id === next.hostId)) throw new Error('Unknown saved host');
    const previous = window.saved.selection;
    if (environmentKey(previous) !== environmentKey(next)) {
      window.saved.selection = next; window.intent = 'disconnected';
      await this.closeForwards(window);
      if (previous.kind === 'remote') await this.connections.get(previous.hostId)?.release(windowId);
    }
    if (window.revision !== revision) return this.snapshot(windowId);
    window.intent = 'connected'; window.saved.connect = next.kind === 'remote';
    await this.save();
    if (this.windows.get(windowId) !== window || window.revision !== revision) return this.snapshot(windowId);
    if (next.kind === 'remote') this.connection(next.hostId).acquire(windowId, true);
    this.changed(); return this.snapshot(windowId);
  }
  async saveContext(windowId: number, input: EnvironmentContext): Promise<EnvironmentSnapshot> {
    this.assertWritable(); const window = this.window(windowId);
    window.saved.contexts[environmentKey(window.saved.selection)] = validate.context(input);
    await this.save(); this.changed(); return this.snapshot(windowId);
  }
  async retry(windowId: number): Promise<EnvironmentSnapshot> {
    this.assertWritable(); const window = this.remoteWindow(windowId);
    const revision = ++window.revision;
    window.intent = 'connected'; window.saved.connect = true; await this.save();
    if (this.windows.get(windowId) !== window || window.revision !== revision) return this.snapshot(windowId);
    this.connection(this.hostId(window)).retry(windowId); this.changed(); return this.snapshot(windowId);
  }
  async disconnect(windowId: number, pause = false): Promise<EnvironmentSnapshot> {
    this.assertWritable(); const window = this.remoteWindow(windowId);
    ++window.revision;
    const hostId = this.hostId(window);
    window.intent = pause ? 'paused' : 'disconnected'; window.saved.connect = false;
    const release = this.connections.get(hostId)?.release(windowId);
    await this.closeForwards(window); await this.save(); await release;
    this.changed(); return this.snapshot(windowId);
  }
  answer(windowId: number, challengeId: string, answer: string | null): void {
    validate.id(challengeId);
    if (answer !== null && (typeof answer !== 'string' || answer.length > 8192 || /[\r\n\0]/.test(answer))) throw new Error('Invalid SSH challenge reply');
    const connection = this.connections.get(this.hostId(this.remoteWindow(windowId)));
    if (!connection) throw new Error('No active SSH challenge');
    connection.answer(windowId, challengeId, answer);
  }
  diagnostics(windowId: number) { return this.connections.get(this.hostId(this.remoteWindow(windowId)))?.logs() ?? []; }

  async addForward(windowId: number, input: RemoteForwardInput): Promise<EnvironmentSnapshot> {
    this.assertWritable(); const window = this.remoteWindow(windowId); const validated = validate.forward(input);
    const inputs = this.forwardInputs(window); if (inputs.length >= 32) throw new Error('Forward limit reached');
    if (inputs.some(value => value.remotePort === validated.remotePort || (validated.localPort && value.localPort === validated.localPort))) throw new Error('This service or local port already has a forward in this window');
    inputs.push({ ...validated, id: randomUUID() }); window.saved.forwards[this.hostId(window)] = inputs;
    await this.save(); this.changed(); return this.snapshot(windowId);
  }
  async retryForward(windowId: number, forwardId: string): Promise<EnvironmentSnapshot> {
    const window = this.remoteWindow(windowId); validate.id(forwardId);
    if (!this.forwardInputs(window).some(input => input.id === forwardId)) throw new Error('Unknown forward');
    const previous = window.forwards.get(forwardId); window.forwards.delete(forwardId); await previous?.running?.close();
    this.changed(); return this.snapshot(windowId);
  }
  async removeForward(windowId: number, forwardId: string): Promise<EnvironmentSnapshot> {
    this.assertWritable(); const window = this.remoteWindow(windowId); validate.id(forwardId);
    if (!this.forwardInputs(window).some(input => input.id === forwardId)) throw new Error('Unknown forward');
    window.saved.forwards[this.hostId(window)] = this.forwardInputs(window).filter(input => input.id !== forwardId);
    const previous = window.forwards.get(forwardId); window.forwards.delete(forwardId); await previous?.running?.close();
    await this.save(); this.changed(); return this.snapshot(windowId);
  }
  networkChanged(): void { for (const connection of this.connections.values()) connection.networkChanged(); }
  dispose(): Promise<void> {
    this.shutdown ??= (async () => {
      this.disposed = true;
      await Promise.all([...this.windows.values()].map(window => this.closeForwards(window)));
      await Promise.all([...this.connections.values()].map(connection => connection.dispose()));
      if (!this.error) await this.save();
      this.listeners.clear(); this.windows.clear(); this.connections.clear();
    })(); return this.shutdown;
  }

  private connection(hostId: string): RemoteConnection {
    let connection = this.connections.get(hostId);
    if (!connection) {
      const host = this.settings.hosts.find(host => host.id === hostId); if (!host) throw new Error('Unknown saved host');
      connection = new RemoteConnection({ ...this.options, host,
        release: async () => { const release = await this.options.release(); this.remoteVersion = release.version; return release; },
        changed: () => this.changed(),
      }); this.connections.set(hostId, connection);
    }
    return connection;
  }
  private window(id: number): WindowState { const window = this.windows.get(id); if (!window) throw new Error('Window is no longer available'); return window; }
  private remoteWindow(id: number): WindowState { const window = this.window(id); this.hostId(window); return window; }
  private hostId(window: WindowState): string { if (window.saved.selection.kind !== 'remote') throw new Error('Select a remote environment first'); return window.saved.selection.hostId; }
  private assertWritable(): void { if (this.disposed) throw new Error('Remote development is shutting down'); if (this.error) throw this.error; }
  private save(): Promise<void> { return this.store.save(this.settings); }
  private forwardInputs(window: WindowState) { return window.saved.selection.kind === 'remote' ? window.saved.forwards[window.saved.selection.hostId] ?? [] : []; }
  private async closeForwards(window: WindowState): Promise<void> {
    const values = [...window.forwards.values()]; window.forwards.clear();
    await Promise.all(values.map(value => value.running?.close()));
  }
  private changed(): void {
    if (this.disposed) return;
    for (const [id, window] of this.windows) {
      this.reconcileForwards(id, window);
      const snapshot = this.snapshot(id);
      for (const listener of this.listeners) { try { listener(id, snapshot); } catch { /* A closing window must not affect other owners. */ } }
    }
  }
  private reconcileForwards(windowId: number, window: WindowState): void {
    if (window.saved.selection.kind !== 'remote' || window.intent !== 'connected') return;
    const connection = this.connections.get(window.saved.selection.hostId);
    const generation = connection?.snapshot().generation ?? 0;
    const transport = connection?.currentTransport();
    for (const input of this.forwardInputs(window)) {
      let entry = window.forwards.get(input.id);
      if (entry && (!transport || entry.generation !== generation)) {
        window.forwards.delete(input.id); void entry.running?.close(); entry = undefined;
      }
      if (!transport || entry) continue;
      const current: WindowForward = { status: { ...input, phase: 'waiting', boundPort: null, message: null }, generation };
      window.forwards.set(input.id, current);
      void transport.forward(input.remotePort, input.localPort, available => {
        if (this.windows.get(windowId) !== window || window.forwards.get(input.id) !== current || connection?.currentTransport() !== transport) return;
        current.available = available;
        current.status = { ...input, phase: available ? 'listening' : 'unavailable', boundPort: current.running?.port ?? null,
          message: available ? null : 'The remote service could not accept a connection. Start the service or retry this forward.' };
        this.changed();
      }).then(async running => {
        if (this.windows.get(windowId) !== window || window.forwards.get(input.id) !== current || connection?.currentTransport() !== transport) { await running.close(); return; }
        current.running = running;
        const available = current.available ?? running.reachable;
        current.status = { ...input, phase: available ? 'listening' : 'unavailable', boundPort: running.port,
          message: available ? null : 'The listener is open, but the remote service is not accepting connections. Start the service and choose Retry forward.' }; this.changed();
      }).catch(error => {
        if (window.forwards.get(input.id) !== current) return;
        const conflict = error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
        current.status = { ...input, phase: conflict ? 'conflict' : 'unavailable', boundPort: null,
          message: conflict ? 'The local port is in use. Remove this forward and choose another port, or retry when it is free.' : 'The forwarding listener could not start. Retry after checking the connection.' }; this.changed();
      });
    }
  }
}
