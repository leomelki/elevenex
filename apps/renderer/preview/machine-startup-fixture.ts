import { Injectable } from '@angular/core';
import type { BackendClientState, BackendStatus, EnvironmentSelection, EnvironmentSnapshot, MachineEditInput, MachineState, RemoteChallenge, RemoteHost, RemoteHostInput } from '@elevenex/shared';

const emptyEnvironment = (): EnvironmentSnapshot => ({ selection: { kind: 'local' }, context: { projectId: null, taskId: null, sessionId: null, draft: '', cursor: null }, connection: null, challenge: null, forwards: [] });

/** Deterministic platform fixture for the production composition, outside its entry graph. */
@Injectable()
export class MachineStartupFixture {
  readonly platform = 'darwin' as const;
  private state: MachineState = { revision: 0, hasOpenedMachine: false, settingsError: null, hosts: [], remoteMachines: [],
    localBackend: { phase: 'downloading', version: 'a'.repeat(40), receivedBytes: 42 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 }, environment: emptyEnvironment(), launchSelection: null };
  private scope: BackendClientState = { revision: 0, scope: null };
  private readonly listeners = new Set<(state: MachineState) => void>();
  private readonly clients = new Set<(state: BackendClientState) => void>();
  readonly windows: (EnvironmentSelection | null)[] = [];
  private nextHost = 0;
  private nextChallenge = 0;
  private readonly removed = new Map<string, { host: RemoteHost; index: number }>();

  machineState = async () => this.state;
  backendClientState = async () => this.scope;
  backendInfo = async () => ({ ok: true as const, value: { backendSha: 'a'.repeat(40) } });
  onMachineStateChanged = (listener: (state: MachineState) => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  onBackendClientChanged = (listener: (state: BackendClientState) => void) => { this.clients.add(listener); return () => { this.clients.delete(listener); }; };
  sshHostSuggestions = async (query: string) => ['dev-box', 'gpu-runner'].filter(host => host.includes(query)).map(host => ({ host }));
  openMachineWindow = async (selection: EnvironmentSelection | null) => { this.windows.push(selection); };
  markMachineOpened = async () => { this.publish({ hasOpenedMachine: true }); return this.state; };
  saveRemoteHost = async (input: RemoteHostInput) => {
    const host = { ...input, id: `server-${++this.nextHost}` };
    this.publish({ hosts: [...this.state.hosts, host] }); return host;
  };
  editMachine = async (selection: EnvironmentSelection, input: MachineEditInput) => {
    if (selection.kind === 'local') this.publish({ localAppearance: { name: input.name, hue: input.hue } });
    else {
      const before = this.state.hosts.find(host => host.id === selection.hostId);
      if (!before || !input.host) throw new Error('Unknown machine');
      const next = { ...before, name: input.name, hue: input.hue, host: input.host, user: input.user, port: input.port, identityFile: input.identityFile === undefined ? before.identityFile : input.identityFile ?? undefined };
      this.publish({ hosts: this.state.hosts.map(host => host.id === next.id ? next : host) });
      if (next.host !== before.host || next.user !== before.user || next.port !== before.port || next.identityFile !== before.identityFile) await this.selectEnvironment(selection);
    }
    return this.state;
  };
  chooseRemoteSshFile = async () => '/fixture/id_ed25519';
  disconnectMachine = async (hostId: string) => {
    if (this.state.environment.selection.kind === 'remote' && this.state.environment.selection.hostId === hostId) await this.disconnectRemote();
    return this.state;
  };
  removeMachine = async (hostId: string, confirmWindows: boolean) => {
    const index = this.state.hosts.findIndex(host => host.id === hostId), host = this.state.hosts[index];
    if (!host) throw new Error('Unknown machine');
    const windows = this.state.remoteMachines.find(machine => machine.hostId === hostId)?.windows ?? (this.state.environment.selection.kind === 'remote' && this.state.environment.selection.hostId === hostId && this.state.environment.connection?.phase === 'ready' ? 1 : 0);
    if (windows && !confirmWindows) throw new Error('Confirm removal');
    const undoToken = `undo-${host.id}`; this.removed.set(undoToken, { host, index });
    this.publish({ hosts: this.state.hosts.filter(host => host.id !== hostId), remoteMachines: this.state.remoteMachines.filter(machine => machine.hostId !== hostId),
      ...(this.state.environment.selection.kind === 'remote' && this.state.environment.selection.hostId === hostId ? { environment: emptyEnvironment() } : {}) });
    return { state: this.state, undoToken };
  };
  undoRemoveMachine = async (token: string) => {
    const removal = this.removed.get(token); if (!removal) throw new Error('Unknown Undo');
    this.removed.delete(token); const hosts = [...this.state.hosts]; hosts.splice(removal.index, 0, removal.host);
    this.publish({ hosts }); return this.state;
  };
  dismissMachineRemoval = async (token: string) => { this.removed.delete(token); };
  selectEnvironment = async (selection: EnvironmentSelection) => {
    this.publish({ environment: { ...emptyEnvironment(), selection, connection: selection.kind === 'remote' ? {
      hostId: selection.hostId, phase: 'connecting', stage: 'authentication', authenticated: false, transport: 'opening', application: 'unknown', attempt: 1, retryAt: null, failure: null, progress: null, generation: 0, instanceId: null,
    } : null } }); return this.state.environment;
  };
  retryBackend = async () => { this.setLocal({ phase: 'starting', version: 'a'.repeat(40) }); return this.state.localBackend; };
  retryRemote = async () => this.selectEnvironment(this.state.environment.selection);
  disconnectRemote = async () => {
    const environment = this.state.environment;
    this.publish({ environment: { ...environment, challenge: null, connection: environment.connection ? { ...environment.connection, phase: 'disconnected' } : null } });
    return this.state.environment;
  };
  answerRemoteChallenge = async (id: string, answer: string | null) => {
    if (id !== this.state.environment.challenge?.id) throw new Error('Expired challenge');
    if (answer === null) await this.disconnectRemote();
    else {
      const connection = this.state.environment.connection;
      if (connection) this.publish({ environment: { ...this.state.environment, challenge: null, connection: { ...connection, phase: 'setting-up', stage: 'installation', authenticated: true } } });
    }
  };

  setLocal(status: BackendStatus): void { this.publish({ localBackend: status }); }
  ready(): void {
    const environment = this.state.environment;
    if (environment.connection) this.publish({ environment: { ...environment, challenge: null, connection: { ...environment.connection, phase: 'ready', transport: 'healthy', application: 'ready', authenticated: true, generation: 1, instanceId: 'test' } } });
    else this.setLocal({ phase: 'ready', version: 'a'.repeat(40), url: 'http://127.0.0.1:11111' });
  }
  challenge(kind: RemoteChallenge['kind'] = 'trust'): void {
    const environment = this.state.environment;
    if (!environment.connection) return;
    this.publish({ environment: { ...environment, connection: { ...environment.connection, phase: 'awaiting-input' }, challenge: {
      id: `challenge-${++this.nextChallenge}`, kind, expiresAt: Date.now() + 120_000,
      prompt: kind === 'trust' ? 'ED25519 key fingerprint is SHA256:fixtureFingerprint123456789.\nAre you sure you want to continue connecting?' : 'Enter the passphrase for your SSH key:',
    } } });
  }
  fail(safety = false): void {
    const environment = this.state.environment;
    if (environment.connection) this.publish({ environment: { ...environment, challenge: null, connection: { ...environment.connection, phase: 'paused', failure: { stage: 'authentication', code: safety ? 'host-trust' : 'authentication', message: safety ? 'The host key changed. Check it before connecting.' : 'Sign-in was refused. Check your SSH key and try again.', action: safety ? 'verify-host' : 'authenticate', transient: false } } } });
    else this.setLocal({ phase: 'failed', version: null, message: 'The engine download was interrupted. Open this machine to try again.' });
  }
  recover(): void {
    const environment = this.state.environment;
    if (environment.connection) this.publish({ environment: { ...environment, connection: { ...environment.connection, phase: 'recovering', retryAt: Date.now() + 4000, transport: 'closed', application: 'unavailable' } } });
  }
  reset(opened = false): void { this.removed.clear(); this.publish({ hasOpenedMachine: opened, localAppearance: undefined, environment: emptyEnvironment(), remoteMachines: [], hosts: [], localBackend: { phase: 'downloading', version: 'a'.repeat(40), receivedBytes: 0, totalBytes: null } }); }

  private publish(patch: Partial<MachineState>): void {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    const connection = this.state.environment.connection;
    this.state = { ...this.state, remoteMachines: connection ? [{ hostId: connection.hostId, connection, windows: connection.phase === 'disconnected' ? 0 : 1 }] : [] };
    const environment = this.state.environment.selection;
    const ready = environment.kind === 'local' ? this.state.localBackend.phase === 'ready' : this.state.environment.connection?.phase === 'ready';
    this.scope = { revision: this.scope.revision + 1, scope: ready ? { id: `fixture-${this.scope.revision + 1}`, environment } : null };
    for (const listener of this.clients) listener(this.scope);
    for (const listener of this.listeners) listener(this.state);
  }
}
