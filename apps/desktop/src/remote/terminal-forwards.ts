import { createHash } from 'node:crypto';
import type { RemoteTransport } from './bootstrap';
import {
  TerminalForwardStore, terminalForwardKey, terminalForwardTarget,
  type TerminalForwardAssignment, type TerminalForwardDefinition, type TerminalForwardService,
} from './terminal-forward-store';

type RunningForward = Awaited<ReturnType<RemoteTransport['forward']>>;
type ForwardChanged = (available: boolean, port?: number, error?: unknown) => void;
interface SharedForward {
  readonly transport: RemoteTransport;
  readonly owners: Map<symbol, ForwardChanged>;
  ready: Promise<RunningForward>;
  available?: boolean;
  port?: number;
  retrying?: Promise<RunningForward>;
  revision: number;
  closing?: Promise<void>;
}
export interface TerminalForwardLease {
  readonly ready: Promise<RunningForward>;
  retry(): Promise<RunningForward>;
  close(): Promise<void>;
}

/** Stable on this desktop for a saved SSH host and exact remote TCP endpoint. */
export function preferredTerminalPort(service: TerminalForwardService): number {
  return 20000 + createHash('sha256').update(terminalForwardKey(service)).digest().readUInt32BE(0) % 10000;
}

/** App-owned assignments and listeners; each window owns a releasable lease. */
export class TerminalForwards {
  private readonly store: TerminalForwardStore;
  private readonly assignments = new Map<string, TerminalForwardAssignment>();
  private readonly assignedPorts = new Set<number>();
  private readonly definitions = new Map<string, TerminalForwardDefinition>();
  private readonly active = new Map<string, SharedForward>();
  private readonly reservations = new Map<number, string>();
  private disposed = false;

  constructor(path: string) { this.store = new TerminalForwardStore(path); }

  async load(hostIds: readonly string[], forwards: readonly { id: string; hostId: string; remotePort: number }[]): Promise<void> {
    const saved = await this.store.load(), hosts = new Set(hostIds);
    const retained = new Map(forwards.map(row => [row.id, row]));
    for (const assignment of saved.assignments) if (hosts.has(assignment.hostId)) {
      this.assignments.set(terminalForwardKey(assignment), assignment);
      this.assignedPorts.add(assignment.localPort);
    }
    for (const definition of saved.definitions) {
      const forward = retained.get(definition.forwardId);
      if (forward?.hostId === definition.hostId && forward.remotePort === definition.remotePort) this.definitions.set(definition.forwardId, definition);
    }
  }

  definition(forwardId: string): TerminalForwardDefinition | undefined { return this.definitions.get(forwardId); }

  async register(forwardId: string, service: TerminalForwardService): Promise<void> {
    this.assertOpen(); terminalForwardTarget(service.targetHost);
    const previous = this.definitions.get(forwardId);
    if (previous && terminalForwardKey(previous) === terminalForwardKey(service)) return;
    if (!previous && this.definitions.size >= 32768) throw new Error('Saved terminal forward limit reached');
    const definition: TerminalForwardDefinition = { hostId: service.hostId, targetHost: service.targetHost, remotePort: service.remotePort, forwardId };
    this.definitions.set(forwardId, definition);
    try { await this.save(); }
    catch (error) {
      if (this.definitions.get(forwardId) === definition) {
        if (previous) this.definitions.set(forwardId, previous); else this.definitions.delete(forwardId);
      }
      throw error;
    }
  }

  async forget(forwardId: string): Promise<void> {
    this.definitions.delete(forwardId);
    // Keep the assignment: reopening a terminal for this service retains its URL.
    await this.save();
  }

  acquire(service: TerminalForwardService, transport: RemoteTransport, changed: ForwardChanged): TerminalForwardLease {
    this.assertOpen();
    const key = terminalForwardKey(service), owner = Symbol();
    let entry = this.active.get(key);
    if (!entry || entry.closing || entry.transport !== transport) {
      const previous = entry ? this.close(entry) : Promise.resolve();
      const owners = new Map<symbol, ForwardChanged>();
      // Defer work until the entry and first owner exist. A replacement waits
      // for the old socket to close before attempting the persisted port.
      const current: SharedForward = {
        transport, owners, revision: 0,
        ready: previous.then(() => this.open(service, transport, current)),
      };
      entry = current;
      this.active.set(key, entry);
    }
    const shared = entry;
    shared.owners.set(owner, changed);
    if (shared.available !== undefined) changed(shared.available, shared.port);
    return {
      get ready() { return shared.ready; },
      retry: () => {
        this.assertOpen();
        if (shared.closing || !shared.owners.has(owner)) return Promise.reject(new Error('Terminal forwarding cancelled'));
        if (shared.retrying) return shared.retrying;
        const previous = shared.ready;
        ++shared.revision;
        shared.ready = previous.then(running => running.close(), () => undefined)
          .then(() => this.open(service, transport, shared))
          .catch(error => { if (!shared.closing) for (const notify of shared.owners.values()) notify(false, undefined, error); throw error; });
        shared.retrying = shared.ready.finally(() => { shared.retrying = undefined; });
        return shared.retrying;
      },
      close: async () => {
        shared.owners.delete(owner);
        if (shared.owners.size) return;
        await this.close(shared);
        if (this.active.get(key) === shared) this.active.delete(key);
      },
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.active.values()].map(entry => this.close(entry)));
    this.active.clear();
  }

  private close(entry: SharedForward): Promise<void> {
    entry.closing ??= entry.ready.then(running => running.close(), () => undefined);
    return entry.closing;
  }

  private publish(entry: SharedForward, available: boolean): void {
    if (entry.closing || this.disposed) return;
    entry.available = available;
    for (const notify of entry.owners.values()) notify(available, entry.port);
  }

  private async open(service: TerminalForwardService, transport: RemoteTransport, entry: SharedForward): Promise<RunningForward> {
    const revision = ++entry.revision;
    entry.port = undefined; entry.available = undefined;
    const running = await this.start(service, transport, entry, available => {
      if (entry.revision === revision) this.publish(entry, available);
    });
    if (entry.revision === revision) { entry.port = running.port; this.publish(entry, entry.available ?? running.reachable); }
    return running;
  }

  private async start(service: TerminalForwardService, transport: RemoteTransport, entry: SharedForward, changed: (available: boolean) => void): Promise<RunningForward> {
    const key = terminalForwardKey(service), saved = this.assignments.get(key);
    const first = saved?.localPort ?? preferredTerminalPort(service);
    // Persisted assignments never silently move when another application takes
    // the port. Initial allocation alone may resolve collisions by probing.
    for (let attempt = 0; attempt < (saved ? 1 : 64); attempt++) {
      if (this.disposed || entry.closing || !entry.owners.size) throw new Error('Terminal forwarding cancelled');
      const port = 20000 + (first - 20000 + attempt) % 10000;
      if (!saved && (this.reservations.has(port) || this.assignedPorts.has(port))) continue;
      this.reservations.set(port, key);
      let running: RunningForward;
      try { running = await transport.forward(service.remotePort, port, changed, service.targetHost); }
      catch (error) {
        this.reservations.delete(port);
        if (!saved && error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') continue;
        throw error;
      }
      try {
        if (this.disposed || entry.closing || !entry.owners.size) throw new Error('Terminal forwarding cancelled');
        if (!saved) {
          const assignment: TerminalForwardAssignment = { hostId: service.hostId, targetHost: service.targetHost, remotePort: service.remotePort, localPort: port };
          this.assignments.set(key, assignment);
          this.assignedPorts.add(port);
          try { await this.save(); }
          catch (error) { this.assignments.delete(key); this.assignedPorts.delete(port); throw error; }
        }
        return running;
      } catch (error) { await running.close(); throw error; }
      finally { this.reservations.delete(port); }
    }
    throw Object.assign(new Error('No deterministic terminal port is available'), { code: 'EADDRINUSE' });
  }

  private save(): Promise<void> {
    return this.store.save({ assignments: [...this.assignments.values()], definitions: [...this.definitions.values()] });
  }
  private assertOpen(): void { if (this.disposed) throw new Error('Terminal forwarding is shutting down'); }
}
