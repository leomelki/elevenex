import { setTimeout as delay } from 'node:timers/promises';
import type { RemoteChallenge, RemoteConnectionStatus, RemoteDiagnostic, RemoteHost, RemoteStage } from '@elevenex/shared';
import type { BackendRelease } from '../backend/release';
import { boundedBody } from '../backend/download';
import { connectRemote, type ConnectOptions, type RemoteTransport } from './bootstrap';
import { asFailure, failure } from './failure';

export interface ConnectionOptions {
  readonly host: RemoteHost;
  readonly root: string;
  readonly helper: string;
  readonly release: () => Promise<BackendRelease>;
  readonly connect?: (options: ConnectOptions) => Promise<RemoteTransport>;
  readonly prepareArchive?: ConnectOptions['prepareArchive'];
  readonly changed: () => void;
  readonly random?: () => number;
  readonly healthInterval?: number;
  readonly backoff?: number;
}

export const disconnected = (hostId: string): RemoteConnectionStatus => ({
  hostId, phase: 'disconnected', stage: 'transport', authenticated: false, transport: 'closed', application: 'unknown',
  attempt: 0, retryAt: null, failure: null, progress: null, generation: 0, instanceId: null,
});

/** One coordinator owns authentication, setup, transport, health and recovery. */
export class RemoteConnection {
  private status: RemoteConnectionStatus;
  private readonly owners = new Set<number>();
  private readonly diagnostics: RemoteDiagnostic[] = [];
  private lifetime: AbortController | undefined;
  private loop: Promise<void> | undefined;
  private wakeup: AbortController | undefined;
  private paused = false;
  private interactiveOwner: number | undefined;
  private requestedInteractiveOwner: number | undefined;
  private attemptInteractive = false;
  private disposed = false;
  private challenge: { value: RemoteChallenge; owner: number; resolve: (value: string | null) => void } | undefined;
  private transport: RemoteTransport | undefined;
  private backendForward: Awaited<ReturnType<RemoteTransport['forward']>> | undefined;

  constructor(private readonly options: ConnectionOptions) { this.status = disconnected(options.host.id); }
  snapshot(): RemoteConnectionStatus { return structuredClone(this.status); }
  logs(): readonly RemoteDiagnostic[] { return structuredClone(this.diagnostics); }
  get active(): boolean { return this.owners.size > 0; }
  currentTransport(): RemoteTransport | undefined { return this.status.phase === 'ready' ? this.transport : undefined; }
  backendUrl(): string | undefined { return this.status.phase === 'ready' && this.backendForward ? `http://127.0.0.1:${this.backendForward.port}` : undefined; }
  /** Main-only capability. Never include this header in an IPC snapshot. */
  backendHeaders(): Readonly<Record<string, string>> { return this.backendForward?.authorization ? { Authorization: this.backendForward.authorization } : {}; }
  challengeFor(windowId: number): RemoteChallenge | null { return this.challenge?.owner === windowId ? { ...this.challenge.value } : null; }

  acquire(windowId: number, interactive: boolean): void {
    if (this.disposed) throw new Error('This remote connection has been disposed');
    this.owners.add(windowId);
    if (interactive && this.status.phase !== 'ready') {
      this.paused = false;
      if (this.loop && this.attemptInteractive && ['connecting', 'awaiting-input', 'setting-up'].includes(this.status.phase)) this.interactiveOwner = windowId;
      else this.requestedInteractiveOwner = windowId;
      // A restored connection may be waiting on a locked agent or dead proxy.
      // Stop its noninteractive authentication promptly; the coordinator waits
      // for owned process cleanup before starting the requested interactive try.
      if (this.loop && !this.attemptInteractive && this.status.stage === 'authentication') this.lifetime?.abort();
    }
    this.ensureLoop();
  }
  async release(windowId: number): Promise<void> {
    this.owners.delete(windowId);
    if (this.interactiveOwner === windowId) this.interactiveOwner = undefined;
    if (this.requestedInteractiveOwner === windowId) this.requestedInteractiveOwner = undefined;
    if (this.challenge?.owner === windowId) {
      const next = this.owners.values().next().value;
      if (next !== undefined) { this.challenge.owner = next; this.interactiveOwner = next; }
      else this.challenge.resolve(null);
      this.options.changed();
    }
    if (this.owners.size) return;
    this.lifetime?.abort(); this.wakeup?.abort();
    await this.loop;
    if (!this.active) this.publish({ ...disconnected(this.options.host.id), generation: this.status.generation });
  }
  retry(windowId: number): void {
    this.acquire(windowId, true); this.wakeup?.abort();
  }
  networkChanged(): void { if (this.active && !this.paused) this.wakeup?.abort(); }
  answer(windowId: number, challengeId: string, answer: string | null): void {
    if (!this.challenge || this.challenge.owner !== windowId || this.challenge.value.id !== challengeId || this.challenge.value.expiresAt <= Date.now()) throw new Error('This SSH challenge is no longer active in this window');
    if (this.challenge.value.kind === 'trust' && answer !== null && answer !== 'yes') throw new Error('Host trust requires the explicit answer yes');
    if (this.challenge.value.kind === 'confirmation' && answer !== null && answer !== 'yes') throw new Error('SSH confirmation requires the explicit answer yes');
    if (this.challenge.value.kind === 'notification') throw new Error('This SSH notification needs no reply; disconnect to cancel the operation');
    this.challenge.resolve(answer);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.owners.clear(); this.lifetime?.abort(); this.wakeup?.abort(); await this.loop;
  }

  private publish(status: RemoteConnectionStatus): void {
    this.status = status; this.options.changed();
  }
  private log(stage: RemoteStage, code: string, message: string): void {
    this.diagnostics.push({ at: Date.now(), stage, code, message });
    if (this.diagnostics.length > 100) this.diagnostics.shift();
  }
  private ask = (value: RemoteChallenge, signal: AbortSignal): Promise<string | null> => {
    const owner = this.interactiveOwner;
    if (owner === undefined || !this.owners.has(owner)) return Promise.resolve(null);
    return new Promise(resolve => {
      const done = (answer: string | null) => {
        signal.removeEventListener('abort', aborted);
        if (this.challenge?.value.id === value.id) this.challenge = undefined;
        if (!signal.aborted && this.status.phase === 'awaiting-input') this.publish({ ...this.status, phase: 'connecting' });
        resolve(answer);
      };
      const aborted = () => done(null);
      this.challenge = { value, owner, resolve: done };
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) done(null);
      else this.publish({ ...this.status, phase: 'awaiting-input' });
    });
  };

  private ensureLoop(): void {
    if (this.disposed || this.loop || !this.active || this.paused) return;
    const lifetime = new AbortController(); this.lifetime = lifetime;
    this.loop = this.coordinate(lifetime.signal).catch(() => {
      // The coordinator classifies all operational errors. This guard protects
      // shutdown if a listener or an adapter violates that boundary.
      if (!lifetime.signal.aborted) {
        this.paused = true;
        const problem = failure('transport', 'configuration', 'Remote cleanup could not complete. Check local SSH process permissions and retry.', 'edit').failure;
        this.log(problem.stage, problem.code, problem.message);
        this.publish({ ...this.status, phase: 'paused', transport: 'closed', application: 'unavailable', retryAt: null, failure: problem });
      }
    }).finally(() => {
      this.loop = undefined; this.lifetime = undefined;
      if (this.active && !this.paused) this.ensureLoop();
    });
  }
  private async coordinate(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted && this.active && !this.paused) {
      this.interactiveOwner = this.requestedInteractiveOwner;
      this.requestedInteractiveOwner = undefined;
      const interactive = this.interactiveOwner !== undefined;
      this.attemptInteractive = interactive;
      let stage: RemoteStage = 'authentication';
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new AbortController();
      const resetDeadline = (next: RemoteStage) => {
        if (timer) clearTimeout(timer);
        const timeout = next === 'download' ? 360_000 : next === 'installation' ? 180_000 : next === 'authentication' && interactive ? 150_000 : 60_000;
        timer = setTimeout(() => deadline.abort(failure(next, 'timeout', 'The remote operation timed out. Check the host and network, then retry.', 'retry', true)), timeout);
      };
      const setupSignal = AbortSignal.any([signal, deadline.signal]);
      try {
        this.publish({ ...this.status, phase: attempt ? 'recovering' : 'connecting', stage, authenticated: false,
          transport: 'opening', application: 'unknown', attempt: ++attempt, retryAt: null, failure: null, progress: null });
        resetDeadline(stage);
        const release = await this.options.release();
        this.log(stage, 'revision', `Expected backend revision ${release.version}; attempt ${attempt}.`);
        setupSignal.throwIfAborted();
        const transport = await (this.options.connect ?? connectRemote)({
          host: this.options.host, root: this.options.root, helper: this.options.helper, release, signal: setupSignal, interactive, ask: this.ask, prepareArchive: this.options.prepareArchive,
          progress: (next, value) => {
            if (setupSignal.aborted) return;
            if (stage !== next) { stage = next; resetDeadline(stage); this.log(stage, 'stage', `Remote ${stage} started.`); }
            this.publish({ ...this.status, phase: next === 'discovery' ? 'connecting' : 'setting-up', stage: next,
              authenticated: true, progress: value ?? null, application: next === 'runtime' ? 'starting' : 'unknown' });
          },
        });
        if (signal.aborted) { await transport.close(); signal.throwIfAborted(); }
        this.transport = transport;
        this.backendForward = await transport.forward(0, 0);
        const url = `http://127.0.0.1:${this.backendForward.port}`;
        // Prove the entire path and exact application revision, independently
        // of SSH, a daemon greeting, or a successfully bound forwarding socket.
        const ready = await this.check(transport, url, release.version, setupSignal);
        if (timer) { clearTimeout(timer); timer = undefined; }
        this.interactiveOwner = undefined;
        this.requestedInteractiveOwner = undefined;
        this.log('application', 'ready', 'Remote application readiness verified.');
        this.publish({ ...this.status, phase: 'ready', stage: 'application', authenticated: true, transport: 'healthy', application: 'ready',
          generation: this.status.generation + 1, instanceId: ready.instance, failure: null, progress: null, retryAt: null });
        const connectedAt = Date.now();
        const transportLost = transport.exited.then(() => { throw failure('transport', 'unavailable', 'The SSH transport closed. Reconnecting to the existing remote work.', 'retry', true); });
        void transportLost.catch(() => undefined);
        while (!signal.aborted) {
          this.wakeup = new AbortController();
          await Promise.race([
            delay(this.options.healthInterval ?? 5000, undefined, { signal: AbortSignal.any([signal, this.wakeup.signal]) }).catch(() => undefined),
            transportLost,
          ]);
          signal.throwIfAborted();
          const current = await this.check(transport, url, release.version, signal);
          if (current.instance !== this.status.instanceId) throw failure('application', 'unavailable', 'The remote runtime restarted. Reconnect and reconcile the selected task and session.', 'retry', true);
          if (Date.now() - connectedAt > 60_000) attempt = 0;
        }
      } catch (error) {
        if (signal.aborted) break;
        const problem = asFailure(deadline.signal.aborted ? deadline.signal.reason : error, stage);
        this.log(problem.stage, problem.code, problem.message);
        this.interactiveOwner = undefined;
        this.paused = !problem.transient && this.requestedInteractiveOwner === undefined;
        this.publish({ ...this.status, phase: this.paused ? 'paused' : 'recovering', stage: problem.stage,
          transport: 'unresponsive', application: 'unavailable', failure: problem, progress: null, retryAt: null });
      } finally {
        if (timer) clearTimeout(timer);
        this.wakeup?.abort();
        deadline.abort();
        this.challenge?.resolve(null); this.challenge = undefined;
        const transport = this.transport; this.transport = undefined;
        const forward = this.backendForward; this.backendForward = undefined;
        await transport?.close(); await forward?.close();
      }
      if (signal.aborted || this.paused || !this.active) break;
      if (this.requestedInteractiveOwner !== undefined) continue;
      const backoff = Math.min(30_000, (this.options.backoff ?? 500) * 2 ** Math.min(attempt - 1, 8));
      const wait = Math.min(30_000, Math.round(backoff * (0.8 + (this.options.random ?? Math.random)() * 0.4)));
      this.publish({ ...this.status, retryAt: Date.now() + wait });
      this.wakeup = new AbortController();
      await delay(wait, undefined, { signal: AbortSignal.any([signal, this.wakeup.signal]) }).catch(() => undefined);
    }
  }

  private async check(transport: RemoteTransport, url: string, version: string, signal: AbortSignal): Promise<{ ready: boolean; instance: string }> {
    const healthSignal = AbortSignal.any([signal, AbortSignal.timeout(4000)]);
    try {
      const health = await transport.health(healthSignal);
      if (!health.ready) throw new Error('Application unavailable');
      const response = await fetch(`${url}/api/info`, { signal: healthSignal, redirect: 'error', headers: this.backendHeaders() });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Application unavailable'); }
      const info: unknown = JSON.parse((await boundedBody(response, 4096)).toString('utf8'));
      if (!info || typeof info !== 'object' || !('backendSha' in info) || info.backendSha !== version) throw failure('application', 'compatibility', 'The remote application revision does not match this desktop. Edit the connection to resolve the runtime conflict.', 'edit');
      return health;
    } catch (error) {
      if (error instanceof Error && 'failure' in error) throw error;
      throw failure('application', 'unavailable', 'The remote application is not responding through the SSH transport. Reconnecting to check it again.', 'retry', true);
    }
  }
}
