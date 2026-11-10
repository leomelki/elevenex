import { createHash, randomUUID } from 'node:crypto';
import { TerminalForwards, type TerminalForwardLease } from './terminal-forwards';
import { terminalForwardTarget } from './terminal-forward-store';
import { WaitingWritingStore, type SavedWaitingWriting } from './waiting-writing-store';
import { waitingWriting } from './waiting-writing';
import type { WaitingWriting, WaitingWritingSnapshot } from '@elevenex/shared';
import type { BackendStatus, EnvironmentContext, EnvironmentSelection, EnvironmentSnapshot, RemoteForward, RemoteForwardInput, RemoteHost, RemoteHostInput, RemoteMachineSummary } from '@elevenex/shared';
import { RemoteConnection, disconnected, type ConnectionOptions } from './connection';
import { RemoteSettingsStore, emptyContext, emptyWindow, environmentKey, type RemoteSettings, type SavedWindow } from './store';
import type { RemoteTransport } from './bootstrap';
import * as validate from './validation';

interface WindowForward {
  status: RemoteForward;
  generation: number;
  running?: Awaited<ReturnType<RemoteTransport['forward']>>;
  available?: boolean;
  lease?: TerminalForwardLease;
}
interface WindowState {
  readonly saved: SavedWindow;
  intent: 'connected' | 'paused' | 'disconnected';
  revision: number;
  pendingHost: string | undefined;
  readonly forwards: Map<string, WindowForward>;
  /** Exact targets for app-owned task processes; generic saved definitions stay compatible. */
  readonly forwardTargets: Map<string, string>;
}
export interface RemoteManagerOptions extends Omit<ConnectionOptions, 'host' | 'changed'> { readonly settingsPath: string }

/** Application-scoped registry; connection and forwarding leases belong to windows. */
export class RemoteManager {
  private settings: RemoteSettings = { hosts: [], windows: [] };
  private readonly windows = new Map<number, WindowState>();
  private readonly connections = new Map<string, RemoteConnection>();
  private readonly retiringConnections = new Set<Promise<void>>();
  private readonly listeners = new Set<(windowId: number, snapshot: EnvironmentSnapshot) => void>();
  private readonly directoryListeners = new Set<() => void>();
  private readonly store: RemoteSettingsStore;
  private readonly waitingStore: WaitingWritingStore;
  private readonly terminalForwards: TerminalForwards;
  private waitingError = false;
  private readonly fileGrants = { identity: new Set<string>(), config: new Set<string>() };
  private error: Error | undefined;
  private disposed = false;
  private shutdown: Promise<void> | undefined;
  private readonly changingMachines = new Set<string>();
  constructor(private readonly options: RemoteManagerOptions) {
    this.store = new RemoteSettingsStore(options.settingsPath);
    this.waitingStore = new WaitingWritingStore(`${options.settingsPath}.waiting-writing.json`);
    this.terminalForwards = new TerminalForwards(`${options.settingsPath}.terminal-forwards.json`);
  }

  async load(): Promise<void> {
    try {
      const settings = await this.store.load();
      await this.terminalForwards.load(settings.hosts.map(host => host.id), settings.windows.flatMap(window =>
        Object.entries(window.forwards).flatMap(([hostId, forwards]) => forwards.filter(forward => forward.localPort === 0)
          .map(forward => ({ id: forward.id, hostId, remotePort: forward.remotePort })))));
      this.settings = settings;
      try { const saved = await this.waitingStore.load(this.settings.hosts.map(host => host.id)); this.settings.windows.forEach((window, index) => { window.waiting = saved[index]; }); } catch { this.waitingError = true; }
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
  subscribeDirectory(listener: () => void): () => void { this.directoryListeners.add(listener); return () => { this.directoryListeners.delete(listener); }; }
  machineStatuses(): readonly RemoteMachineSummary[] {
    const windowsByHost = new Map<string, number>();
    for (const window of this.windows.values()) {
      if (window.intent === 'connected' && window.saved.selection.kind === 'remote') {
        const id = window.saved.selection.hostId;
        windowsByHost.set(id, (windowsByHost.get(id) ?? 0) + 1);
      }
    }
    return this.settings.hosts.flatMap(host => {
      const connection = this.connections.get(host.id);
      return connection ? [{ hostId: host.id, connection: connection.snapshot(), windows: windowsByHost.get(host.id) ?? 0 }] : [];
    });
  }
  attach(windowId: number, requested?: EnvironmentSelection | null): void {
    if (this.disposed || this.windows.has(windowId)) return;
    if (this.windows.size >= 32) throw new Error('Too many desktop windows');
    const occupied = new Set([...this.windows.values()].map(value => value.saved));
    const saved = this.settings.windows.find(value => !occupied.has(value)) ?? emptyWindow();
    // Explicit new-window requests must not restore a different host and start
    // an unrelated SSH connection before selecting their destination.
    if (requested !== undefined) { saved.selection = requested ?? { kind: 'local' }; saved.connect = false; }
    if (!this.settings.windows.includes(saved)) {
      if (this.settings.windows.length >= 32) throw new Error('Too many saved desktop windows');
      this.settings.windows.push(saved);
    }
    this.windows.set(windowId, { saved, intent: saved.connect ? 'connected' : 'disconnected', revision: 0, pendingHost: undefined, forwards: new Map(), forwardTargets: new Map() });
    // Launch restoration is deliberately noninteractive. Unknown trust or a
    // locked key pauses rather than presenting a background credential dialog.
    if (saved.connect && saved.selection.kind === 'remote') this.connection(saved.selection.hostId).acquire(windowId, false);
    this.changed({ windowId });
  }
  async detach(windowId: number): Promise<void> {
    const window = this.windows.get(windowId); if (!window) return;
    this.windows.delete(windowId);
    this.changed();
    const release = window.saved.selection.kind === 'remote' ? this.connections.get(window.saved.selection.hostId)?.release(windowId) : undefined;
    await Promise.all([this.closeForwards(window), release]);
  }
  snapshot(windowId: number): EnvironmentSnapshot {
    const window = this.window(windowId);
    const selection = window.saved.selection;
    const connection = selection.kind === 'remote' ? this.connections.get(selection.hostId) : undefined;
    let status = selection.kind === 'remote' ? connection?.snapshot() ?? disconnected(selection.hostId) : null;
    if (status && window.intent !== 'connected') status = { ...disconnected(status.hostId),
      phase: window.intent === 'paused' ? 'paused' : 'disconnected', generation: status.generation, instanceId: status.instanceId };
    return structuredClone({ selection, context: window.saved.contexts[environmentKey(selection)] ?? emptyContext(), connection: status,
      challenge: window.intent === 'connected' ? connection?.challengeFor(windowId) ?? null : null,
      forwards: selection.kind === 'remote' ? this.forwardInputs(window).map(input => window.intent !== 'connected'
        ? { ...input, phase: 'stopped', boundPort: null, message: null }
        : window.forwards.get(input.id)?.status ?? { ...input, phase: 'waiting', boundPort: null, message: null }) : [],
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
    if (hostId !== null) this.assertMachineAvailable(hostId);
    this.assertWritable(); const validated = validate.hostInput(input);
    if (validated.identityFile && !this.fileGrants.identity.has(validated.identityFile)) throw new Error('Choose the identity file with the desktop file picker first');
    if (validated.configFile && !this.fileGrants.config.has(validated.configFile)) throw new Error('Choose the SSH config file with the desktop file picker first');
    const current = hostId === null ? undefined : this.settings.hosts.find(host => host.id === validate.id(hostId));
    if (hostId !== null && !current) throw new Error('Unknown saved host');
    if (current && this.hostInUse(current.id)) throw new Error('Disconnect this host in every window before editing its shared settings');
    if (!current && this.settings.hosts.length >= 100) throw new Error('Saved host limit reached');
    const host = { ...validated, id: current?.id ?? randomUUID() };
    const previousIdentity = current ? this.writingIdentity({ kind: 'remote', hostId: current.id }) : null;
    if (current) {
      this.settings.hosts.splice(this.settings.hosts.indexOf(current), 1, host);
      if (previousIdentity !== this.writingIdentity({ kind: 'remote', hostId: host.id })) {
        for (const window of this.settings.windows) if (window.waiting) delete window.waiting[host.id];
      }
      await this.retireConnection(host.id);
    }
    else this.settings.hosts.push(host);
    await this.save(); this.changed(); return { ...host };
  }
  async removeHost(hostId: string): Promise<void> {
    this.assertMachineAvailable(hostId);
    this.assertWritable(); validate.id(hostId);
    if (this.hostInUse(hostId)) throw new Error('Disconnect this host in every window before removing it');
    if (!this.settings.hosts.some(host => host.id === hostId)) throw new Error('Unknown saved host');
    this.settings.hosts = this.settings.hosts.filter(host => host.id !== hostId);
    const retirement = this.retireConnection(hostId);
    for (const window of this.settings.windows) {
      delete window.contexts[hostId]; delete window.forwards[hostId]; if (window.waiting) delete window.waiting[hostId];
      if (window.selection.kind === 'remote' && window.selection.hostId === hostId) { window.selection = { kind: 'local' }; window.connect = false; }
    }
    await retirement;
    await this.save(); this.changed();
  }
  /** Machine Home operations are additive. Legacy save/remove still require idle hosts. */
  async editMachineHost(windowId: number, input: RemoteHostInput, hostId: string): Promise<void> {
    this.assertWritable(); this.window(windowId); this.assertMachineAvailable(hostId);
    const next = validate.hostInput(input);
    const before = this.settings.hosts.find(host => host.id === validate.id(hostId));
    if (!before) throw new Error('Unknown saved machine');
    if (next.identityFile && !this.fileGrants.identity.has(next.identityFile)) throw new Error('Choose the identity file with the desktop file picker first');
    if (next.configFile && !this.fileGrants.config.has(next.configFile)) throw new Error('Choose the SSH config file with the desktop file picker first');
    const moved = next.host !== before.host || next.user !== before.user || next.port !== before.port || next.identityFile !== before.identityFile || next.configFile !== before.configFile;
    this.changingMachines.add(hostId);
    try {
      this.settings.hosts = this.settings.hosts.map(host => host.id === hostId ? { ...next, id: hostId } : host);
      try { await this.save(); }
      catch (error) { this.settings.hosts = this.settings.hosts.map(host => host.id === hostId ? before : host); throw error; }
      if (moved) {
        for (const saved of this.settings.windows) if (saved.waiting) delete saved.waiting[hostId];
        await this.save();
        // Invalidate in-flight selects before retiring the old shared connection.
        const attached = [...this.windows.entries()].filter(([, window]) => window.saved.selection.kind === 'remote' && window.saved.selection.hostId === hostId);
        for (const [, window] of attached) { ++window.revision; window.pendingHost = undefined; }
        await Promise.all([this.retireConnection(hostId), ...attached.map(([, window]) => this.closeForwards(window))]);
        for (const [id, window] of attached) if (this.windows.get(id) === window && window.intent === 'connected' && window.saved.selection.kind === 'remote' && window.saved.selection.hostId === hostId) this.connection(hostId).acquire(id, id === windowId);
      }
      this.changed();
    } finally { this.changingMachines.delete(hostId); }
    // Even an idle edited destination is checked on its card; it does not launch.
    if (moved && this.windows.has(windowId)) await this.select(windowId, { kind: 'remote', hostId });
  }

  async disconnectMachineHost(hostId: string): Promise<void> {
    this.assertWritable(); validate.id(hostId); this.assertMachineAvailable(hostId);
    if (!this.settings.hosts.some(host => host.id === hostId)) throw new Error('Unknown saved machine');
    this.changingMachines.add(hostId);
    try {
      const windows = [...this.windows.entries()].filter(([, window]) => window.saved.selection.kind === 'remote' && window.saved.selection.hostId === hostId);
      await Promise.all(windows.map(([id]) => this.disconnect(id)));
      this.changed();
    } finally { this.changingMachines.delete(hostId); }
  }

  async removeMachineHost(hostId: string, confirmWindows: boolean): Promise<{ readonly host: RemoteHost; readonly index: number }> {
    this.assertWritable(); validate.id(hostId); this.assertMachineAvailable(hostId);
    if (typeof confirmWindows !== 'boolean') throw new Error('Invalid removal confirmation');
    const index = this.settings.hosts.findIndex(host => host.id === hostId), host = this.settings.hosts[index];
    if (!host) throw new Error('Unknown saved machine');
    if (!confirmWindows && this.hostInUse(hostId)) throw new Error('This machine has open windows. Confirm removal first.');
    this.changingMachines.add(hostId);
    try {
      const attached = [...this.windows.entries()].filter(([, window]) => window.saved.selection.kind === 'remote' && window.saved.selection.hostId === hostId || window.pendingHost === hostId);
      for (const [, window] of attached) { ++window.revision; window.pendingHost = undefined; window.intent = 'disconnected'; }
      await Promise.all([this.retireConnection(hostId), ...attached.map(([, window]) => this.closeForwards(window))]);
      const savedWindows = this.settings.windows.map(window => ({ window, selection: window.selection,
        revision: [...this.windows.values()].find(value => value.saved === window)?.revision,
        context: window.contexts[hostId], forwards: window.forwards[hostId] }));
      this.settings.hosts = this.settings.hosts.filter(value => value.id !== hostId);
      for (const { window } of savedWindows) {
        delete window.contexts[hostId]; delete window.forwards[hostId]; if (window.waiting) delete window.waiting[hostId];
        if (window.selection.kind === 'remote' && window.selection.hostId === hostId) { window.selection = { kind: 'local' }; window.connect = false; }
      }
      try { await this.save(); }
      catch (error) {
        this.settings.hosts.splice(index, 0, host);
        for (const saved of savedWindows) {
          const active = [...this.windows.values()].find(value => value.saved === saved.window);
          if (saved.selection.kind === 'remote' && saved.selection.hostId === hostId && saved.window.selection.kind === 'local' && (!active || active.revision === saved.revision)) {
            saved.window.selection = saved.selection; saved.window.connect = false;
          }
          if (saved.context) saved.window.contexts[hostId] = saved.context;
          if (saved.forwards) saved.window.forwards[hostId] = saved.forwards;
        }
        this.changed(); throw error;
      }
      this.changed(); return { host, index };
    } finally { this.changingMachines.delete(hostId); }
  }

  /** Accepts only main-owned Undo data, never arbitrary renderer-supplied hosts. */
  async restoreMachineHost(host: RemoteHost, index: number): Promise<void> {
    this.assertWritable(); this.assertMachineAvailable(host.id);
    if (this.settings.hosts.length >= 100 || this.settings.hosts.some(value => value.id === host.id)) throw new Error('This machine cannot be restored');
    this.settings.hosts.splice(Math.min(index, this.settings.hosts.length), 0, host);
    try { await this.save(); }
    catch (error) { this.settings.hosts = this.settings.hosts.filter(value => value.id !== host.id); throw error; }
    this.changed();
  }

  private assertMachineAvailable(hostId: string): void {
    if (this.changingMachines.has(hostId)) throw new Error('This machine is being changed. Try again.');
  }

  async select(windowId: number, input: EnvironmentSelection): Promise<EnvironmentSnapshot> {
    this.assertWritable(); const next = validate.selection(input); const window = this.window(windowId);
    if (next.kind === 'remote') this.assertMachineAvailable(next.hostId);
    if (next.kind === 'remote' && !this.settings.hosts.some(host => host.id === next.hostId)) throw new Error('Unknown saved host');
    const revision = ++window.revision;
    window.pendingHost = next.kind === 'remote' ? next.hostId : undefined;
    try {
      const previous = window.saved.selection;
      if (environmentKey(previous) !== environmentKey(next)) {
        window.saved.selection = next; window.intent = 'disconnected'; window.saved.connect = false;
        this.changed({ windowId });
        // Relinquish the old lease before yielding: another selection may acquire
        // that same host while its forwarded sockets are still closing.
        const release = previous.kind === 'remote' ? this.connections.get(previous.hostId)?.release(windowId) : undefined;
        await Promise.all([this.closeForwards(window), release]);
      }
      this.assertWritable();
      if (this.windows.get(windowId) !== window || window.revision !== revision) return this.snapshot(windowId);
      window.intent = 'connected'; window.saved.connect = next.kind === 'remote';
      await this.save();
      this.assertWritable();
      if (this.windows.get(windowId) !== window || window.revision !== revision) return this.snapshot(windowId);
      if (next.kind === 'remote') this.connection(next.hostId).acquire(windowId, true);
      this.changed({ windowId }); return this.snapshot(windowId);
    } catch (error) {
      if (this.windows.get(windowId) === window && window.revision === revision) {
        window.intent = 'disconnected'; window.saved.connect = false;
        if (next.kind === 'remote') await this.connections.get(next.hostId)?.release(windowId);
      }
      throw error;
    } finally { if (window.revision === revision) window.pendingHost = undefined; }
  }
  /** Stable destination identity for main-owned resource caches, never a credential. */
  backendCacheIdentity(windowId: number): string {
    const selection = this.window(windowId).saved.selection;
    const host = selection.kind === 'remote' ? this.settings.hosts.find(host => host.id === selection.hostId) : null;
    return createHash('sha256').update(JSON.stringify(host ? [host.id, host.host, host.user, host.port, host.configFile] : ['local'])).digest('hex');
  }
  private writingIdentity(selection: EnvironmentSelection): string {
    const host = selection.kind === 'remote' ? this.settings.hosts.find(host => host.id === selection.hostId) : null;
    if (selection.kind === 'remote' && !host) throw new Error('Unknown machine');
    return createHash('sha256').update(JSON.stringify(host ? [host.id, host.host, host.user, host.port, host.identityFile, host.configFile] : ['local'])).digest('hex');
  }
  waitingRead(windowId: number, expected: EnvironmentSelection): WaitingWritingSnapshot {
    this.assertWritable(); if (this.waitingError) throw new Error('Waiting writing needs repair.'); const window = this.window(windowId), selection = validate.selection(expected);
    if (environmentKey(selection) !== environmentKey(window.saved.selection)) throw new Error('The selected machine changed.');
    const saved: SavedWaitingWriting = window.saved.waiting?.[environmentKey(selection)] ?? { chat: [], tasks: [] };
    const identity = this.writingIdentity(selection);
    if (selection.kind === 'remote' && saved.identity !== identity) {
      // Never give unbound/old-destination writing a new identity while it can
      // still dispatch. Retain it for inspection, including version-1 journals.
      const unverified = <T extends { readonly status: string }>(item: T): T => item.status === 'waiting' || item.status === 'sending'
        ? { ...item, status: 'unknown', error: 'The saved SSH destination could not be verified. Inspect the original machine before creating or sending this again. Nothing will be retried.' } : item;
      return structuredClone({ identity, chat: saved.chat.map(unverified), tasks: saved.tasks.map(unverified), ...(saved.sessions ? { sessions: saved.sessions.map(unverified) } : {}) });
    }
    return structuredClone({ ...saved, identity });
  }
  async waitingSave(windowId: number, expected: EnvironmentSelection, identity: string, input: WaitingWriting): Promise<void> {
    this.assertWritable(); if (this.waitingError) throw new Error('Waiting writing needs repair.'); const window = this.window(windowId), selection = validate.selection(expected), key = environmentKey(selection);
    if (key !== environmentKey(window.saved.selection) || identity !== this.writingIdentity(selection)) throw new Error('The selected machine changed.');
    const saved = { ...waitingWriting(input), identity }, previous = window.saved.waiting?.[key];
    window.saved.waiting ??= {}; window.saved.waiting[key] = saved;
    try { await this.save(); }
    catch { if (window.saved.waiting[key] === saved) { if (previous) window.saved.waiting[key] = previous; else delete window.saved.waiting[key]; } throw new Error('Waiting writing could not be saved.'); }
    if (this.windows.get(windowId) !== window || key !== environmentKey(window.saved.selection) || identity !== this.writingIdentity(selection)) throw new Error('The selected machine changed.');
  }
  async saveContext(windowId: number, input: EnvironmentContext, expected: EnvironmentSelection): Promise<EnvironmentSnapshot> {
    this.assertWritable(); const window = this.window(windowId);
    if (environmentKey(validate.selection(expected)) !== environmentKey(window.saved.selection)) throw new Error('The selected environment changed; discard this stale context update');
    window.saved.contexts[environmentKey(window.saved.selection)] = validate.context(input);
    await this.save(); this.changed({ windowId }); return this.snapshot(windowId);
  }
  async retry(windowId: number): Promise<EnvironmentSnapshot> {
    this.assertWritable(); const window = this.remoteWindow(windowId);
    this.assertMachineAvailable(this.hostId(window));
    const revision = ++window.revision;
    window.pendingHost = this.hostId(window);
    try {
      window.intent = 'connected'; window.saved.connect = true; await this.save();
      this.assertWritable();
      if (this.windows.get(windowId) !== window || window.revision !== revision) return this.snapshot(windowId);
      this.connection(this.hostId(window)).retry(windowId); this.changed({ windowId }); return this.snapshot(windowId);
    } catch (error) {
      if (this.windows.get(windowId) === window && window.revision === revision) {
        window.intent = 'disconnected'; window.saved.connect = false;
        await this.connections.get(this.hostId(window))?.release(windowId);
      }
      throw error;
    } finally { if (window.revision === revision) window.pendingHost = undefined; }
  }
  async disconnect(windowId: number, pause = false): Promise<EnvironmentSnapshot> {
    this.assertWritable(); const window = this.remoteWindow(windowId);
    ++window.revision;
    window.pendingHost = undefined;
    const hostId = this.hostId(window);
    window.intent = pause ? 'paused' : 'disconnected'; window.saved.connect = false;
    // Publish intent before slow socket/process cleanup or persistence. A window
    // must stop presenting a usable backend as soon as its lease is relinquished.
    this.changed({ windowId });
    const release = this.connections.get(hostId)?.release(windowId);
    await this.closeForwards(window); await this.save(); await release;
    this.changed({ windowId }); return this.snapshot(windowId);
  }
  answer(windowId: number, challengeId: string, answer: string | null): void {
    validate.id(challengeId);
    if (answer !== null && (typeof answer !== 'string' || answer.length > 8192 || /[\r\n\0]/.test(answer))) throw new Error('Invalid SSH challenge reply');
    const connection = this.connections.get(this.hostId(this.remoteWindow(windowId)));
    if (!connection) throw new Error('No active SSH challenge');
    connection.answer(windowId, challengeId, answer);
  }
  diagnostics(windowId: number) { return this.connections.get(this.hostId(this.remoteWindow(windowId)))?.logs() ?? []; }

  async addForward(windowId: number, input: RemoteForwardInput, targetHost?: string): Promise<EnvironmentSnapshot> {
    this.assertWritable(); const window = this.remoteWindow(windowId); const validated = validate.forward(input);
    if (targetHost !== undefined) terminalForwardTarget(targetHost);
    const retained = new Set(Object.values(window.saved.forwards).flatMap(inputs => inputs.map(input => input.id)));
    for (const id of window.forwardTargets.keys()) if (!retained.has(id)) window.forwardTargets.delete(id);
    const inputs = this.forwardInputs(window); if (inputs.length >= 32) throw new Error('Forward limit reached');
    if (inputs.some(value => value.remotePort === validated.remotePort || (validated.localPort && value.localPort === validated.localPort))) throw new Error('This service or local port already has a forward in this window');
    const id = randomUUID();
    if (targetHost !== undefined) window.forwardTargets.set(id, targetHost);
    inputs.push({ ...validated, id }); window.saved.forwards[this.hostId(window)] = inputs;
    try {
      if (targetHost !== undefined && validated.localPort === 0) await this.terminalForwards.register(id, {
        hostId: this.hostId(window), targetHost, remotePort: validated.remotePort,
      });
      await this.save();
    } catch (error) {
      const index = inputs.findIndex(input => input.id === id); if (index >= 0) inputs.splice(index, 1);
      window.forwardTargets.delete(id);
      const pending = window.forwards.get(id); window.forwards.delete(id); await this.closeForward(pending);
      throw error;
    }
    this.changed({ windowId }); return this.snapshot(windowId);
  }
  /** Main-only: bind a task's user-requested forward to its verified socket family.
   * Automatic definitions also retain the exact target in a compatible sidecar;
   * manual forwards keep their existing window-owned override. */
  async targetForward(windowId: number, forwardId: string, host: string): Promise<boolean> {
    this.assertWritable(); terminalForwardTarget(host);
    const window = this.remoteWindow(windowId); validate.id(forwardId);
    const input = this.forwardInputs(window).find(input => input.id === forwardId);
    if (!input) throw new Error('Unknown forward');
    const definition = this.terminalForwards.definition(forwardId);
    const previousHost = window.forwardTargets.get(forwardId) ?? definition?.targetHost ?? '127.0.0.1';
    if (previousHost === host && (input.localPort !== 0 || definition)) return false;
    if (input.localPort === 0) await this.terminalForwards.register(forwardId, { hostId: this.hostId(window), targetHost: host, remotePort: input.remotePort });
    window.forwardTargets.set(forwardId, host);
    // A different endpoint requires a new lease. Retrying the existing shared
    // lease would also retarget other windows that still own the old endpoint.
    const previous = window.forwards.get(forwardId); window.forwards.delete(forwardId); await this.closeForward(previous);
    this.changed({ windowId });
    return true;
  }
  async retryForward(windowId: number, forwardId: string): Promise<EnvironmentSnapshot> {
    this.assertWritable();
    const window = this.remoteWindow(windowId); validate.id(forwardId);
    if (!this.forwardInputs(window).some(input => input.id === forwardId)) throw new Error('Unknown forward');
    const retained = window.forwards.get(forwardId);
    if (retained?.lease) {
      // Retry the shared listener for every owner, rather than allocating a
      // competing socket or requiring all other windows to disconnect first.
      await retained.lease.retry().catch(() => undefined);
      return this.snapshot(windowId);
    }
    const previous = window.forwards.get(forwardId); window.forwards.delete(forwardId); await this.closeForward(previous);
    this.changed({ windowId }); return this.snapshot(windowId);
  }
  async removeForward(windowId: number, forwardId: string): Promise<EnvironmentSnapshot> {
    this.assertWritable(); const window = this.remoteWindow(windowId); validate.id(forwardId);
    if (!this.forwardInputs(window).some(input => input.id === forwardId)) throw new Error('Unknown forward');
    window.saved.forwards[this.hostId(window)] = this.forwardInputs(window).filter(input => input.id !== forwardId);
    window.forwardTargets.delete(forwardId);
    const previous = window.forwards.get(forwardId); window.forwards.delete(forwardId); await this.closeForward(previous);
    await this.save(); await this.terminalForwards.forget(forwardId); this.changed({ windowId }); return this.snapshot(windowId);
  }
  networkChanged(): void { for (const connection of this.connections.values()) connection.networkChanged(); }
  dispose(): Promise<void> {
    this.shutdown ??= (async () => {
      this.disposed = true;
      await Promise.all([
        ...[...this.connections.values()].map(connection => connection.dispose()),
        ...this.retiringConnections,
        ...[...this.windows.values()].map(window => this.closeForwards(window)),
        this.terminalForwards.dispose(),
      ]);
      if (!this.error) await this.save();
      this.listeners.clear(); this.directoryListeners.clear(); this.windows.clear(); this.connections.clear();
    })(); return this.shutdown;
  }

  private connection(hostId: string): RemoteConnection {
    this.assertWritable();
    let connection = this.connections.get(hostId);
    if (!connection) {
      const host = this.settings.hosts.find(host => host.id === hostId); if (!host) throw new Error('Unknown saved host');
      connection = new RemoteConnection({ ...this.options, host,
        release: async () => { const release = await this.options.release(); this.remoteVersion = release.version; return release; },
        changed: () => this.changed({ hostId }),
      }); this.connections.set(hostId, connection);
    }
    return connection;
  }
  private retireConnection(hostId: string): Promise<void> {
    const previous = this.connections.get(hostId); this.connections.delete(hostId);
    // Detach synchronously, so an overlapping connect only sees the new host.
    // Keep cleanup owned by the application even after it leaves the registry.
    const retiring = (previous?.dispose() ?? Promise.resolve()).finally(() => this.retiringConnections.delete(retiring));
    this.retiringConnections.add(retiring); return retiring;
  }
  private window(id: number): WindowState { const window = this.windows.get(id); if (!window) throw new Error('Window is no longer available'); return window; }
  private remoteWindow(id: number): WindowState { const window = this.window(id); this.hostId(window); return window; }
  private hostId(window: WindowState): string { if (window.saved.selection.kind !== 'remote') throw new Error('Select a remote environment first'); return window.saved.selection.hostId; }
  private assertWritable(): void { if (this.disposed) throw new Error('Remote development is shutting down'); if (this.error) throw this.error; }
  private hostInUse(hostId: string): boolean {
    return !!this.connections.get(hostId)?.active || [...this.windows.values()].some(window => window.pendingHost === hostId
      || window.intent === 'connected' && window.saved.selection.kind === 'remote' && window.saved.selection.hostId === hostId);
  }
  private async save(): Promise<void> { await Promise.all([this.store.save(this.settings), ...(this.waitingError ? [] : [this.waitingStore.save(this.settings.windows.map(window => window.waiting ?? {}))])]); }
  private forwardInputs(window: WindowState) { return window.saved.selection.kind === 'remote' ? window.saved.forwards[window.saved.selection.hostId] ?? [] : []; }
  private async closeForwards(window: WindowState): Promise<void> {
    const values = [...window.forwards.values()]; window.forwards.clear();
    await Promise.all(values.map(value => this.closeForward(value)));
  }
  private async closeForward(value: WindowForward | undefined): Promise<void> {
    if (value?.lease) await value.lease.close(); else await value?.running?.close();
  }
  private changed(scope?: { readonly hostId: string } | { readonly windowId: number }): void {
    if (this.disposed) return;
    for (const listener of this.directoryListeners) { try { listener(); } catch { /* A closing directory cannot affect connection owners. */ } }
    for (const [id, window] of this.windows) {
      if (scope && ('windowId' in scope ? id !== scope.windowId
        : window.saved.selection.kind !== 'remote' || window.saved.selection.hostId !== scope.hostId)) continue;
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
        window.forwards.delete(input.id); void this.closeForward(entry); entry = undefined;
      }
      if (!transport || entry) continue;
      const current: WindowForward = { status: { ...input, phase: 'waiting', boundPort: null, message: null }, generation };
      window.forwards.set(input.id, current);
      const availableChanged = (available: boolean, port?: number, error?: unknown) => {
        if (this.windows.get(windowId) !== window || window.forwards.get(input.id) !== current || connection?.currentTransport() !== transport) return;
        if (error !== undefined) { this.forwardFailed(windowId, current, error); return; }
        current.available = available;
        current.status = { ...input, phase: available ? 'listening' : 'unavailable', boundPort: port ?? current.running?.port ?? null,
          message: available ? null : 'The remote service could not accept a connection. Start the service or retry this forward.' };
        this.changed({ windowId });
      };
      const definition = input.localPort === 0 ? this.terminalForwards.definition(input.id) : undefined;
      if (definition) current.lease = this.terminalForwards.acquire(definition, transport, availableChanged);
      const starting = current.lease?.ready ?? transport.forward(input.remotePort, input.localPort, availableChanged, window.forwardTargets.get(input.id));
      void starting.then(async running => {
        if (this.windows.get(windowId) !== window || window.forwards.get(input.id) !== current || connection?.currentTransport() !== transport) {
          if (current.lease) await current.lease.close(); else await running.close();
          return;
        }
        current.running = running;
        const available = current.available ?? running.reachable;
        current.status = { ...input, phase: available ? 'listening' : 'unavailable', boundPort: running.port,
          message: available ? null : 'The listener is open, but the remote service is not accepting connections. Start the service and choose Retry forward.' }; this.changed({ windowId });
      }).catch(error => {
        if (window.forwards.get(input.id) !== current) return;
        this.forwardFailed(windowId, current, error);
      });
    }
  }
  private forwardFailed(windowId: number, current: WindowForward, error: unknown): void {
    const conflict = error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
    current.status = { ...current.status, phase: conflict ? 'conflict' : 'unavailable', boundPort: null,
      message: conflict ? 'The local port is in use. Remove this forward and choose another port, or retry when it is free.' : 'The forwarding listener could not start. Retry after checking the connection.' };
    this.changed({ windowId });
  }
}
