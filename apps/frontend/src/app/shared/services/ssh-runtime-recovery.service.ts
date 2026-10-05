import { Injectable, OnDestroy, computed, effect, signal, untracked } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';
import { awaitConnectionOperation } from '../runtime/connection-operation';

import { ELEVENEX_REMOTE_PORT } from '../constants/elevenex';
import { SavedServer } from '../models/onboarding.model';
import { SshForward, SshForwardStatus } from '../models/ssh-forward.model';
import { ElectronSshForwardRuntimeState, getElectronSshForwardingApi } from '../runtime/electron-ssh-forwarding';
import { RemoteInstallPhase } from '../runtime/electron-remote-server';
import { NavigationService } from './navigation.service';
import { OnboardingConnectionService, OnboardingConnectionSuccess } from './onboarding-connection.service';
import { OnboardingStartupService } from './onboarding-startup.service';
import { OnboardingStateService } from './onboarding-state.service';
import { ProjectsService } from './projects.service';
import { ServerConnectionPhase, ServerConnectionService } from './server-connection.service';
import { SshForwardsService } from './ssh-forwards.service';

const POLL_INTERVAL_MS = 3000;
/**
 * How long the backend websocket must stay disconnected (in SSH mode) before we
 * treat the tunnel as the culprit and drive SSH recovery. The heartbeat timeout
 * has already elapsed by the time we reach `disconnected`, so this only filters
 * out fast, normal websocket reconnects (e.g. a quick backend restart).
 */
const SERVER_DISCONNECT_GRACE_MS = 4000;
const AUTO_RETRY_DELAYS_MS = [5000, 10000, 20000, 30000];

export const CONNECTING_PHASES = [
  'Connecting via SSH',
  'Checking runtime',
  'Downloading files',
  'Starting service',
  'Testing connection',
] as const;

export function remoteInstallPhaseToIndex(phase: RemoteInstallPhase | null): number {
  switch (phase) {
    case 'checking': return 1;
    case 'uploading': return 2;
    case 'installing': return 2;
    case 'starting': return 3;
    case 'probing': return 4;
    case 'ready': return CONNECTING_PHASES.length;
    default: return 0;
  }
}

export interface RuntimeDisconnectedForwardItem {
  id: number;
  projectId: number;
  name: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  destinationLabel: string;
  lastError: string | null;
}

export interface RuntimeDisconnectedForwardsBanner {
  totalCount: number;
  forwards: RuntimeDisconnectedForwardItem[];
  reconnectingIds: number[];
}

export interface RemoteRuntimeDisconnectState {
  server: SavedServer;
  message: string;
  localPort: number;
}

export interface RemoteRuntimeConnectingState {
  server: SavedServer;
  localPort: number;
  phaseIndex: number;
}

function isLiveStatus(status: SshForwardStatus | ElectronSshForwardRuntimeState['status'] | null): boolean {
  return status === 'active' || status === 'connecting';
}

function isDisconnectedStatus(status: SshForwardStatus | ElectronSshForwardRuntimeState['status'] | null): boolean {
  return status === 'inactive' || status === 'error';
}

function toDisconnectedForwardItem(forward: SshForward): RuntimeDisconnectedForwardItem {
  return {
    id: forward.id,
    projectId: forward.projectId,
    name: forward.name,
    localPort: forward.localPort,
    remoteHost: forward.remoteHost,
    remotePort: forward.remotePort,
    destinationLabel: forward.destinationLabel,
    lastError: forward.lastError,
  };
}

@Injectable({ providedIn: 'root' })
export class SshRuntimeRecoveryService implements OnDestroy {
  private readonly _disconnectedForwardsBanner = signal<RuntimeDisconnectedForwardsBanner | null>(null);
  private readonly _remoteDisconnect = signal<RemoteRuntimeDisconnectState | null>(null);
  private readonly _remoteRetrying = signal<{ server: SavedServer; localPort: number; phaseOverride: number | null } | null>(null);
  readonly disconnectedForwardsBanner = this._disconnectedForwardsBanner.asReadonly();
  readonly retryInSeconds = signal<number | null>(null);
  readonly automaticRetryPaused = signal(false);
  readonly remoteDisconnect = this._remoteDisconnect.asReadonly();
  readonly remoteConnecting = computed<RemoteRuntimeConnectingState | null>(() => {
    const startupServer = this.onboardingStartup.startupConnectingServer();
    const retry = this._remoteRetrying();

    let server: SavedServer | null = null;
    let localPort = 0;
    let phaseOverride: number | null = null;
    if (retry) {
      server = retry.server;
      localPort = retry.localPort;
      phaseOverride = retry.phaseOverride;
    } else if (startupServer) {
      server = startupServer;
      localPort = startupServer.localPort;
      if (this.onboardingStartup.startupVerifying()) phaseOverride = CONNECTING_PHASES.length - 1;
    }

    if (!server) {
      return null;
    }

    const phaseIndex = phaseOverride
      ?? remoteInstallPhaseToIndex(this.onboardingConnection.currentPhase());
    return { server, localPort, phaseIndex };
  });

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private savedHydrated = false;
  private savedBannerVisible = true;
  private refreshInFlight = false;
  private refreshQueued = false;
  private previousSavedStatuses = new Map<number, SshForwardStatus>();
  private disconnectedSavedForwards = new Map<number, RuntimeDisconnectedForwardItem>();
  private reconnectingSavedIds = new Set<number>();
  private cancelToken = 0;
  private savedDisconnect: RemoteRuntimeDisconnectState | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAt: number | null = null;
  private automaticAttempts = 0;
  private monitoringGeneration = 0;
  private monitoringStarted = false;
  private recoveryController: AbortController | null = null;
  private readonly wakeListener = () => {
    if (this.automaticRetryPaused() || this._remoteRetrying() || this.onboardingStartup.startupConnectingServer()) return;
    const disconnected = this._remoteDisconnect();
    if (disconnected && disconnected.server.authMode !== 'password') {
      void this.attemptRemoteConnection(disconnected.server, disconnected.message, false);
    } else {
      void this.refreshNow();
    }
  };
  private serverDisconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sshForwardsService: SshForwardsService,
    private readonly projectsService: ProjectsService,
    private readonly onboardingState: OnboardingStateService,
    private readonly onboardingConnection: OnboardingConnectionService,
    private readonly onboardingStartup: OnboardingStartupService,
    private readonly navigationService: NavigationService,
    private readonly serverConnection: ServerConnectionService,
  ) {
    effect(() => {
      const failure = this.onboardingStartup.startupFailure();
      if (!failure || this._remoteRetrying()) {
        return;
      }
      untracked(() => {
        this.setRemoteDisconnect(failure.server, failure.message);
        if (failure.retryable !== false) this.scheduleAutomaticRetry(failure.server);
        else this.automaticRetryPaused.set(true);
      });
    });

    // The backend websocket is the fastest, most reliable "backend unreachable"
    // signal. In SSH mode a dead tunnel keeps the forwarded local port open, so the
    // tunnel status can read 'active' for ~90s while the websocket stalls — leaving
    // the user stuck on the generic, non-actionable server overlay. React to the
    // websocket loss directly to drive SSH recovery instead of waiting on the slow
    // ssh-process-exit edge.
    effect(() => {
      const phase = this.serverConnection.state().phase;
      untracked(() => this.handleServerPhaseChange(phase));
    });
  }

  private handleServerPhaseChange(phase: ServerConnectionPhase): void {
    if (phase === 'disconnected') {
      if (this.serverDisconnectGraceTimer === null) {
        this.serverDisconnectGraceTimer = setTimeout(() => {
          this.serverDisconnectGraceTimer = null;
          void this.handleBackendUnreachable();
        }, SERVER_DISCONNECT_GRACE_MS);
      }
      return;
    }
    // 'connecting' (pre-first-connect), 'connected' or 'restored': cancel any pending
    // recovery trigger — the websocket recovered on its own.
    this.clearServerDisconnectGraceTimer();
  }

  private clearServerDisconnectGraceTimer(): void {
    if (this.serverDisconnectGraceTimer !== null) {
      clearTimeout(this.serverDisconnectGraceTimer);
      this.serverDisconnectGraceTimer = null;
    }
  }

  /**
   * The backend has been unreachable past the grace window. In SSH mode this almost
   * always means the tunnel (or the remote server) is down, so attempt a bounded
   * silent reconnect and fall back to the actionable disconnect overlay.
   */
  private async handleBackendUnreachable(): Promise<void> {
    if (this.serverConnection.state().phase !== 'disconnected') {
      return;
    }
    if (this.automaticRetryPaused() || this._remoteDisconnect() || this._remoteRetrying() || this.onboardingStartup.startupConnectingServer()) {
      return;
    }

    const snapshot = this.onboardingState.readSnapshot();
    if (snapshot.mode !== 'ssh' || !snapshot.remoteConnectionReady) {
      return;
    }

    const activeServer = this.onboardingState.getActiveServer(snapshot);
    if (!activeServer) {
      return;
    }

    const disconnectMessage = `The Elevenex tunnel to ${activeServer.sshHost}:${ELEVENEX_REMOTE_PORT} disconnected.`;

    // Password auth can't reconnect silently — surface the actionable overlay so the
    // user can re-enter credentials.
    if (activeServer.authMode === 'password') {
      this.setRemoteDisconnect(activeServer, disconnectMessage);
      return;
    }

    await this.attemptRemoteConnection(activeServer, disconnectMessage, false);
  }

  private isCurrentAttempt(token: number, server: SavedServer): boolean {
    const snapshot = this.onboardingState.readSnapshot();
    return this.cancelToken === token && snapshot.mode === 'ssh'
      && this.onboardingState.getActiveServer(snapshot)?.id === server.id;
  }

  private clearAutomaticRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAt = null;
    this.retryInSeconds.set(null);
  }

  private scheduleAutomaticRetry(server: SavedServer): void {
    if (this.automaticRetryPaused() || server.authMode === 'password' || this.retryTimer !== null) return;
    const delay = AUTO_RETRY_DELAYS_MS[Math.min(this.automaticAttempts++, AUTO_RETRY_DELAYS_MS.length - 1)];
    this.retryAt = Date.now() + delay;
    this.retryInSeconds.set(Math.ceil(delay / 1000));
    this.retryTimer = setTimeout(() => {
      this.clearAutomaticRetry();
      const current = this._remoteDisconnect();
      if (current?.server.id === server.id) void this.attemptRemoteConnection(server, current.message, false);
    }, delay);
  }

  setRemoteDisconnect(server: SavedServer, message: string): void {
    if (this._remoteRetrying()) {
      return;
    }
    this._remoteDisconnect.set({
      server,
      localPort: server.localPort,
      message,
    });
    this.savedDisconnect = null;
  }

  clearRemoteDisconnect(pauseAutomaticRecovery = false): void {
    ++this.cancelToken;
    this.recoveryController?.abort();
    this.recoveryController = null;
    this.clearAutomaticRetry();
    this.automaticAttempts = 0;
    this.automaticRetryPaused.set(pauseAutomaticRecovery);
    this._remoteRetrying.set(null);
    this._remoteDisconnect.set(null);
    this.savedDisconnect = null;
  }

  async startMonitoring(): Promise<void> {
    if (this.monitoringStarted) return;
    this.monitoringStarted = true;
    const generation = ++this.monitoringGeneration;
    if (!(await this.sshForwardsService.isSupported()) || generation !== this.monitoringGeneration) {
      if (generation === this.monitoringGeneration) this.stopMonitoring();
      return;
    }
    window.addEventListener?.('online', this.wakeListener);
    window.addEventListener?.('focus', this.wakeListener);
    // Start polling before the first refresh, which may be waiting on the backend.
    this.pollTimer = setInterval(() => {
      if (this.retryAt !== null) this.retryInSeconds.set(Math.max(0, Math.ceil((this.retryAt - Date.now()) / 1000)));
      void this.refreshNow();
    }, POLL_INTERVAL_MS);
    await this.refreshNow();
  }

  stopMonitoring(): void {
    ++this.monitoringGeneration;
    this.monitoringStarted = false;
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
    window.removeEventListener?.('online', this.wakeListener);
    window.removeEventListener?.('focus', this.wakeListener);
    this.clearAutomaticRetry();
    this.clearServerDisconnectGraceTimer();
  }

  ngOnDestroy(): void {
    this.stopMonitoring();
    ++this.cancelToken;
    this.recoveryController?.abort();
    this.onboardingConnection.cancelCurrentConnection();
  }

  async refreshNow(): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return;
    }

    this.refreshInFlight = true;
    try {
      await this.refreshRemoteTunnel();
      if (this.serverConnection.isInteractive()) await this.refreshSavedForwards();
    } finally {
      this.refreshInFlight = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        await this.refreshNow();
      }
    }
  }

  dismissDisconnectedForwardsBanner() {
    this.savedBannerVisible = false;
    this.syncDisconnectedForwardsBanner();
  }

  async reconnectAllDisconnectedForwards(): Promise<Array<{ id: number; name: string; error: Error }>> {
    const forwards = Array.from(this.disconnectedSavedForwards.values());
    if (forwards.length === 0) {
      return [];
    }

    const results = await Promise.allSettled(forwards.map(f => this.reconnectSavedForward(f.id)));
    const failures: Array<{ id: number; name: string; error: Error }> = [];
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const forward = forwards[index];
        failures.push({
          id: forward.id,
          name: forward.name,
          error: result.reason instanceof Error ? result.reason : new Error('Could not reconnect the SSH forward.'),
        });
      }
    });

    return failures;
  }

  async retryRemoteConnection(options: { password?: string; passphrase?: string } = {}): Promise<void> {
    const current = this._remoteDisconnect();
    if (!current || this._remoteRetrying()) return;
    this.automaticRetryPaused.set(false);
    this.automaticAttempts = 0;
    await this.attemptRemoteConnection(current.server, current.message, true, options);
  }

  private async attemptRemoteConnection(
    server: SavedServer,
    message: string,
    interactive: boolean,
    options: { password?: string; passphrase?: string } = {},
  ): Promise<void> {
    if (this._remoteRetrying() || this.onboardingStartup.startupConnectingServer()
      || (!interactive && this.automaticRetryPaused())) return;
    const snapshot = this.onboardingState.readSnapshot();
    if (snapshot.mode !== 'ssh' || this.onboardingState.getActiveServer(snapshot)?.id !== server.id) return;
    this.clearAutomaticRetry();
    this.savedDisconnect = { server, localPort: server.localPort, message };
    this._remoteDisconnect.set(null);
    const token = ++this.cancelToken;
    const controller = new AbortController();
    this.recoveryController = controller;
    this._remoteRetrying.set({ server, localPort: server.localPort, phaseOverride: null });
    try {
      const result = await this.onboardingConnection.reconnect(server,
        interactive ? { interactive, password: options.password, passphrase: options.passphrase } : { interactive });
      if (!this.isCurrentAttempt(token, server)) return;
      if (result.kind === 'success') {
        await this.handleReconnectionSuccess(server, result, token);
        return;
      }
      this._remoteRetrying.set(null);
      this.setRemoteDisconnect(server, result.message || message);
      if (result.kind === 'error' && result.retryable !== false) this.scheduleAutomaticRetry(server);
      else this.automaticRetryPaused.set(true);
    } catch (error) {
      if (!this.isCurrentAttempt(token, server)) return;
      const disconnectedServer = this._remoteRetrying()?.server ?? server;
      this._remoteRetrying.set(null);
      this.setRemoteDisconnect(disconnectedServer, error instanceof Error ? error.message : message);
      this.scheduleAutomaticRetry(server);
    } finally {
      if (this.recoveryController === controller) this.recoveryController = null;
    }
  }

  private async handleReconnectionSuccess(
    server: SavedServer,
    result: OnboardingConnectionSuccess,
    token: number,
  ): Promise<void> {
    if (!this.isCurrentAttempt(token, server)) return;
    const nextServer: SavedServer = {
      ...server,
      localPort: result.localPort,
      installStatus: result.installStatus,
      lastConnectedAt: new Date().toISOString(),
    };
    this.onboardingState.saveServer(nextServer);
    this._remoteRetrying.set({ server: nextServer, localPort: result.localPort, phaseOverride: CONNECTING_PHASES.length - 1 });
    // Repoint the request gate immediately; no HTTP request is needed to trigger it.
    this.serverConnection.recheck();
    await awaitConnectionOperation(this.serverConnection.waitUntilInteractive(this.recoveryController?.signal), this.recoveryController?.signal, 15000);
    if (!this.isCurrentAttempt(token, server)) return;
    this.onboardingStartup.clearStartupFailure();
    this._remoteRetrying.set(null);
    this._remoteDisconnect.set(null);
    this.savedDisconnect = null;
    this.clearAutomaticRetry();
    this.automaticAttempts = 0;
    this.navigationService.refreshTree();
    // Ancillary forwards must never keep the workspace's connection overlay open.
    void this.restoreSavedForwards(nextServer, token).catch(() => undefined);
  }

  private async restoreSavedForwards(server: SavedServer, token: number): Promise<void> {
    await this.refreshSavedForwards();
    if (!this.isCurrentAttempt(token, server)) return;
    await this.reconnectAllDisconnectedForwards();
    if (!this.isCurrentAttempt(token, server)) return;
    await this.onboardingStartup.prepareStartupPortForwardPrompt(server);
  }

  cancelRemoteConnection(): void {
    const startupServer = this.onboardingStartup.startupConnectingServer();
    const retry = this._remoteRetrying();
    const disconnected = this.savedDisconnect ?? this._remoteDisconnect();
    const server = retry?.server ?? startupServer ?? disconnected?.server;
    ++this.cancelToken;
    this.automaticRetryPaused.set(true);
    this.clearAutomaticRetry();
    this.clearServerDisconnectGraceTimer();
    this.recoveryController?.abort();
    this.onboardingStartup.cancelStartupConnection();
    this.onboardingStartup.clearStartupFailure();
    this.onboardingConnection.cancelCurrentConnection();
    this._remoteRetrying.set(null);
    this.savedDisconnect = null;
    if (server) this.setRemoteDisconnect(server, 'Connection canceled. Automatic reconnection is paused. Reconnect when you are ready.');
  }

  private async reconnectSavedForward(id: number): Promise<void> {
    if (this.reconnectingSavedIds.has(id)) {
      return;
    }

    const token = this.cancelToken;
    this.reconnectingSavedIds.add(id);
    this.syncDisconnectedForwardsBanner();
    try {
      await firstValueFrom(this.sshForwardsService.start(id).pipe(timeout(10000)));
      if (token !== this.cancelToken) return;
      this.previousSavedStatuses.set(id, 'active');
      this.disconnectedSavedForwards.delete(id);
    } finally {
      this.reconnectingSavedIds.delete(id);
      this.syncDisconnectedForwardsBanner();
    }
  }

  private async refreshSavedForwards(): Promise<void> {
    const token = this.cancelToken;
    const [allForwards, activeProjects] = await Promise.all([
      awaitConnectionOperation(this.sshForwardsService.getAllOnce(), undefined, 8000).catch(() => null),
      firstValueFrom(this.projectsService.getAll('active').pipe(timeout(8000))).catch(() => null),
    ]);
    if (!allForwards || !activeProjects || token !== this.cancelToken) return;
    const activeProjectIds = new Set(activeProjects.map(p => p.id));
    const forwards = allForwards.filter(f => activeProjectIds.has(f.projectId));
    const currentStatuses = new Map<number, SshForwardStatus>();

    for (const forward of forwards) {
      currentStatuses.set(forward.id, forward.status);
      const previousStatus = this.previousSavedStatuses.get(forward.id) ?? null;

      if (
        this.savedHydrated
        && isLiveStatus(previousStatus)
        && isDisconnectedStatus(forward.status)
      ) {
        this.disconnectedSavedForwards.set(forward.id, toDisconnectedForwardItem(forward));
        this.savedBannerVisible = true;
      }

      if (isLiveStatus(forward.status)) {
        this.disconnectedSavedForwards.delete(forward.id);
      } else if (this.disconnectedSavedForwards.has(forward.id)) {
        this.disconnectedSavedForwards.set(forward.id, toDisconnectedForwardItem(forward));
      }
    }

    for (const id of Array.from(this.previousSavedStatuses.keys())) {
      if (!currentStatuses.has(id)) {
        this.previousSavedStatuses.delete(id);
        this.disconnectedSavedForwards.delete(id);
        this.reconnectingSavedIds.delete(id);
      }
    }

    this.previousSavedStatuses = currentStatuses;
    this.savedHydrated = true;
    this.syncDisconnectedForwardsBanner();
  }

  private async refreshRemoteTunnel(): Promise<void> {
    if (this._remoteRetrying() || this.onboardingStartup.startupConnectingServer()) {
      return;
    }

    const snapshot = this.onboardingState.readSnapshot();
    if (snapshot.mode !== 'ssh' || !snapshot.remoteConnectionReady) {
      this._remoteDisconnect.set(null);
      return;
    }

    const activeServer = this.onboardingState.getActiveServer(snapshot);
    const api = getElectronSshForwardingApi();
    if (!activeServer || !api) {
      this._remoteDisconnect.set(null);
      return;
    }

    const token = this.cancelToken;
    const runtime = await awaitConnectionOperation(api.getState(activeServer.id), undefined, 5000).catch(() => null);
    if (!this.isCurrentAttempt(token, activeServer) || this._remoteRetrying()
      || this.onboardingStartup.startupConnectingServer()) return;
    const currentStatus = runtime?.status ?? 'inactive';
    const interactive = this.serverConnection.isInteractive();
    if (currentStatus === 'active' && interactive) {
      if (!this.automaticRetryPaused()) {
        this._remoteDisconnect.set(null);
        this.clearAutomaticRetry();
        this.automaticAttempts = 0;
        this.onboardingStartup.clearStartupFailure();
      }
    } else if (isDisconnectedStatus(currentStatus) && !this._remoteDisconnect()) {
      const message = runtime?.lastError
        || `The Elevenex tunnel to ${activeServer.sshHost}:${ELEVENEX_REMOTE_PORT} disconnected.`;
      if (activeServer.authMode === 'password' || this.automaticRetryPaused()) {
        this.setRemoteDisconnect(activeServer, message);
      } else {
        await this.attemptRemoteConnection(activeServer, message, false);
      }
    }
  }


  private syncDisconnectedForwardsBanner() {
    const forwards = Array.from(this.disconnectedSavedForwards.values())
      .sort((left, right) => left.name.localeCompare(right.name));

    if (!this.savedBannerVisible || forwards.length === 0) {
      this._disconnectedForwardsBanner.set(null);
      return;
    }

    this._disconnectedForwardsBanner.set({
      totalCount: forwards.length,
      forwards,
      reconnectingIds: Array.from(this.reconnectingSavedIds.values()),
    });
  }
}
