import { setTimeout as delay } from 'node:timers/promises';
import type { RemoteChallenge, RemoteConnectionStatus, RemoteDiagnostic, RemoteHost, RemoteStage } from '@elevenex/shared';
import type { BackendRelease } from '../backend/release';
import { boundedBody } from '../backend/download';
import { connectRemote, type ConnectOptions, type RemoteTransport } from './bootstrap';
import { asFailure, failure } from './failure';
import type { SshAuthentication } from './ssh-authentication';

export interface ConnectionOptions {
  readonly host: RemoteHost;
  readonly root: string;
  readonly helper: string;
  readonly environment?: ConnectOptions['environment'];
  readonly release: () => Promise<BackendRelease>;
  readonly connect?: (options: ConnectOptions) => Promise<RemoteTransport>;
  readonly prepareArchive?: ConnectOptions['prepareArchive'];
  readonly developmentNamespace?: ConnectOptions['developmentNamespace'];
  readonly changed: () => void;
  readonly random?: () => number;
  readonly healthInterval?: number;
  readonly backoff?: number;
  readonly retryWindow?: number;
  /** How long health may stay delayed while the transport still delivers bytes. */
  readonly delayedHealthWindow?: number;
  readonly now?: () => number;
  /** Overrides the sign-in deadline; tests use it to observe expiry. */
  readonly authenticationTimeout?: number;
}

/** Ordinary agent and hardware signing finishes well within this delay. */
const SLOW_SIGN_IN_NOTICE = 3000;
// Hedged: the wait is usually a confirmation outside the app, but can be a slow
// server-side account check. Either way it needs a person, not timed retries.
const unfinishedSignIn = () => failure('authentication', 'authentication',
  'SSH sign-in didn’t finish. If your SSH agent, security key or PIN asked you to confirm, choose Try again and confirm it.', 'authenticate');

/** One attempt's SSH login progress; owns the delayed slow-sign-in notice. */
class SignInProgress {
  private state: SshAuthentication = 'connecting';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private showing = false;
  /** The notice appeared during this attempt; later failures are explained in its terms. */
  noticed = false;
  constructor(private readonly notice: (slow: boolean) => void, private readonly suppressed: () => boolean) {}
  /** The server accepted a key and the login has not finished. */
  get afterKeyAccepted(): boolean { return this.state === 'key-accepted'; }
  update(state: SshAuthentication): void {
    this.state = state;
    if (state !== 'key-accepted') { this.finish(); return; }
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      // A prompt inside this app (passphrase, PIN) already says what to do.
      if (this.state !== 'key-accepted' || this.suppressed()) return;
      this.showing = this.noticed = true; this.notice(true);
    }, SLOW_SIGN_IN_NOTICE);
  }
  /** Login left the waiting state or the attempt ended. */
  finish(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.showing) { this.showing = false; this.notice(false); }
  }
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
  private outageStarted: number | undefined;
  private interactiveOwner: number | undefined;
  private requestedInteractiveOwner: number | undefined;
  private attemptInteractive = false;
  private disposed = false;
  private challenge: { value: RemoteChallenge; owner: number; resolve: (value: string | null) => void } | undefined;
  private remoteShell?: 'posix' | 'windows';
  private transport: RemoteTransport | undefined;
  private backendForward: Awaited<ReturnType<RemoteTransport['forward']>> | undefined;
  private forcePendingUpdate: (() => void) | undefined;
  private forcedInstance: string | undefined;
  /** "Start without apps" lasts for this connection; every new connect asks again. */
  private backgroundSession = false;

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
    this.backgroundSession = false;
    this.lifetime?.abort(); this.wakeup?.abort();
    await this.loop;
    if (!this.active) this.publish({ ...disconnected(this.options.host.id), generation: this.status.generation });
  }
  retry(windowId: number): void {
    this.outageStarted = undefined;
    this.status = { ...this.status, retryStoppedAt: undefined };
    this.acquire(windowId, true); this.wakeup?.abort();
  }
  forceUpdate(windowId: number, instance: string): void {
    if (!this.owners.has(windowId) || this.status.updateWaiting?.instance !== instance || !this.forcePendingUpdate) throw new Error('This remote update is no longer waiting.');
    this.forcePendingUpdate();
    this.forcePendingUpdate = undefined;
    this.forcedInstance = instance;
    this.publish({ ...this.status, updateWaiting: undefined });
  }
  /** Accept a runtime without a Windows desktop session after a connect paused for that choice. */
  allowBackgroundSession(): void {
    if (this.status.phase !== 'paused' || this.status.failure?.action !== 'choose-session') throw new Error('This server is no longer waiting for a Windows sign-in.');
    this.backgroundSession = true;
  }
  async useDesktopSession(windowId: number): Promise<'switching' | 'signed-out'> {
    if (!this.owners.has(windowId)) throw new Error('This window is not connected to the server.');
    const transport = this.currentTransport();
    if (!transport?.useDesktopSession) throw new Error('Apps are already available on this server, or it is reconnecting.');
    const outcome = await transport.useDesktopSession(AbortSignal.timeout(30_000));
    // The bridge closes after a confirmed switch; recovery then starts the
    // desktop runtime, or asks again if the account signed out meanwhile.
    if (outcome === 'switching') { this.backgroundSession = false; this.log('runtime', 'desktop-session', 'Moving the remote runtime to the Windows desktop session.'); }
    return outcome;
  }
  networkChanged(): void {
    if (!this.active) return;
    // Only the clock stop resumes automatically. Authentication/trust failures wait for a person.
    if (this.status.retryStoppedAt !== undefined) {
      this.paused = false; this.outageStarted = undefined;
      this.status = { ...this.status, retryStoppedAt: undefined };
      this.ensureLoop();
    }
    if (!this.paused) this.wakeup?.abort();
  }
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
      const setupSignal = AbortSignal.any([signal, deadline.signal]);
      // A login stalled after key acceptance usually waits on a confirmation the
      // app cannot see. Retrying it in the background would raise another one.
      const signIn = new SignInProgress(slow => {
        if (!slow && !this.status.slowSignIn) return;
        if (slow) this.log('authentication', 'slow-sign-in', 'SSH sign-in is waiting after the server accepted a key.');
        this.publish({ ...this.status, slowSignIn: slow ? true : undefined });
      }, () => this.challenge !== undefined || setupSignal.aborted);
      const resetDeadline = (next: RemoteStage) => {
        if (timer) clearTimeout(timer);
        const timeout = next === 'download' ? 360_000 : next === 'installation' ? 180_000 : next === 'authentication' ? this.options.authenticationTimeout ?? (interactive ? 150_000 : 60_000) : 60_000;
        timer = setTimeout(() => deadline.abort(next === 'authentication' && signIn.afterKeyAccepted && !this.challenge ? unfinishedSignIn()
          : failure(next, 'timeout', 'The remote operation timed out. Check the host and network, then retry.', 'retry', true)), timeout);
      };
      const authentication = (state: SshAuthentication) => { if (!setupSignal.aborted && stage === 'authentication') signIn.update(state); };
      try {
        this.publish({ ...this.status, phase: attempt ? 'recovering' : 'connecting', stage, authenticated: false,
          transport: 'opening', application: 'unknown', attempt: ++attempt, retryAt: null, failure: null, progress: null, updateWaiting: undefined, slowSignIn: undefined, windowsSession: undefined });
        resetDeadline(stage);
        const release = await this.options.release();
        this.log(stage, 'revision', `Expected backend revision ${release.version}; attempt ${attempt}.`);
        setupSignal.throwIfAborted();
        const transport = await (this.options.connect ?? connectRemote)({
          remoteShell: this.remoteShell, host: this.options.host, root: this.options.root, helper: this.options.helper, environment: this.options.environment, release, signal: setupSignal, interactive, ask: this.ask, authentication, prepareArchive: this.options.prepareArchive, developmentNamespace: this.options.developmentNamespace, allowBackgroundSession: this.backgroundSession,
          progress: (next, value) => {
            if (setupSignal.aborted) return;
            if (stage !== next) { stage = next; resetDeadline(stage); this.log(stage, 'stage', `Remote ${stage} started.`); }
            if (stage !== 'authentication') signIn.finish();
            this.publish({ ...this.status, phase: next === 'discovery' ? 'connecting' : 'setting-up', stage: next,
              authenticated: true, progress: value ?? null, application: next === 'runtime' ? 'starting' : 'unknown' });
          },
          waitingForUpdate: (update, force) => {
            if (setupSignal.aborted || !interactive) return;
            resetDeadline('runtime');
            if (this.forcedInstance === update.instance) return;
            this.forcePendingUpdate = force;
            const before = this.status.updateWaiting;
            if (before?.instance !== update.instance || before.connections !== update.connections) this.publish({ ...this.status, updateWaiting: update });
          },
          updateStarting: instance => {
            if (setupSignal.aborted) return;
            resetDeadline('runtime');
            if (this.status.updateWaiting?.instance !== instance) return;
            this.forcePendingUpdate = undefined;
            this.publish({ ...this.status, updateWaiting: undefined });
          },
        });
        if (signal.aborted) { await transport.close(); signal.throwIfAborted(); }
        this.remoteShell = transport.remoteShell;
        this.transport = transport;
        this.backendForward = await transport.forward(0, 0);
        const url = `http://127.0.0.1:${this.backendForward.port}`;
        // Prove the entire path and exact application revision, independently
        // of SSH, a daemon greeting, or a successfully bound forwarding socket.
        const ready = await this.check(transport, url, release.version, setupSignal);
        if (timer) { clearTimeout(timer); timer = undefined; }
        this.interactiveOwner = undefined;
        this.requestedInteractiveOwner = undefined;
        this.outageStarted = undefined;
        this.log('application', 'ready', 'Remote application readiness verified.');
        this.publish({ ...this.status, phase: 'ready', stage: 'application', authenticated: true, transport: 'healthy', application: 'ready',
          generation: this.status.generation + 1, instanceId: ready.instance, failure: null, progress: null, retryAt: null, retryStoppedAt: undefined, unreachableSince: undefined, updateWaiting: undefined,
          windowsSession: transport.windowsSession });
        const connectedAt = Date.now();
        const transportLost = transport.exited.then(() => { throw failure('transport', 'unavailable', 'The SSH transport closed. Reconnecting to the existing remote work.', 'retry', true); });
        void transportLost.catch(() => undefined);
        let delayedSince: number | undefined;
        while (!signal.aborted) {
          this.wakeup = new AbortController();
          await Promise.race([
            delay(this.options.healthInterval ?? 5000, undefined, { signal: AbortSignal.any([signal, this.wakeup.signal]) }).catch(() => undefined),
            transportLost,
          ]);
          signal.throwIfAborted();
          const checkedAt = Date.now();
          let current: { ready: boolean; instance: string };
          try { current = await this.check(transport, url, release.version, signal); }
          catch (error) {
            // Health replies share the SSH stream with bulk frames. On a slow
            // link they can queue behind a transcript or media transfer for
            // longer than the check timeout. Closing that live transport would
            // discard the transfer and repeat the resync that saturated it, so
            // only a silent transport, or a delay past the grace window, is lost.
            const delivering = (transport.receivedAt?.() ?? 0) > checkedAt;
            delayedSince ??= checkedAt;
            if (signal.aborted || !delivering || !asFailure(error, 'application').transient || Date.now() - delayedSince > (this.options.delayedHealthWindow ?? 60_000)) throw error;
            if (delayedSince === checkedAt) this.log('application', 'delayed', 'The remote health reply was delayed behind other transfers. Keeping the active SSH transport.');
            continue;
          }
          delayedSince = undefined;
          if (current.instance !== this.status.instanceId) throw failure('application', 'unavailable', 'The remote runtime restarted. Reconnect and reconcile the selected task and session.', 'retry', true);
          if (Date.now() - connectedAt > 60_000) attempt = 0;
        }
      } catch (error) {
        if (signal.aborted) break;
        let problem = asFailure(deadline.signal.aborted ? deadline.signal.reason : error, stage);
        // An approver that declines or times out on its own makes SSH report an
        // ordinary key failure; keep explaining it as the sign-in the person saw.
        if (signIn.noticed && problem.stage === 'authentication' && problem.code === 'authentication') problem = unfinishedSignIn().failure;
        this.log(problem.stage, problem.code, problem.message);
        this.interactiveOwner = undefined;
        const now = (this.options.now ?? Date.now)();
        this.outageStarted ??= now;
        const stopped = problem.transient && now - this.outageStarted >= (this.options.retryWindow ?? 600_000);
        this.paused = stopped || !problem.transient && this.requestedInteractiveOwner === undefined;
        this.publish({ ...this.status, phase: this.paused ? 'paused' : 'recovering', stage: problem.stage,
          transport: 'unresponsive', application: 'unavailable', failure: problem, progress: null, retryAt: null, unreachableSince: this.outageStarted, retryStoppedAt: stopped ? now : undefined, updateWaiting: undefined, slowSignIn: undefined });
      } finally {
        if (timer) clearTimeout(timer);
        signIn.finish();
        this.forcePendingUpdate = undefined;
        this.forcedInstance = undefined;
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
