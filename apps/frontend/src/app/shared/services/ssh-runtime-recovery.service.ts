import { Injectable, computed, effect, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

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
/** Upper bound on a silent reconnect attempt so a hung `ssh` spawn can't freeze recovery. */
const RECONNECT_TIMEOUT_MS = 20000;

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
export class SshRuntimeRecoveryService {
  private readonly _disconnectedForwardsBanner = signal<RuntimeDisconnectedForwardsBanner | null>(null);
  private readonly _remoteDisconnect = signal<RemoteRuntimeDisconnectState | null>(null);
  private readonly _remoteRetrying = signal<{ server: SavedServer; localPort: number; phaseOverride: number | null } | null>(null);
  readonly disconnectedForwardsBanner = this._disconnectedForwardsBanner.asReadonly();
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
  private remoteHydrated = false;
  private savedBannerVisible = true;
  private refreshInFlight = false;
  private refreshQueued = false;
  private previousSavedStatuses = new Map<number, SshForwardStatus>();
  private disconnectedSavedForwards = new Map<number, RuntimeDisconnectedForwardItem>();
  private reconnectingSavedIds = new Set<number>();
  private previousRemoteStatus: ElectronSshForwardRuntimeState['status'] | null = null;
  private previousRemoteServerId: number | null = null;
  private cancelToken = 0;
  private savedDisconnect: RemoteRuntimeDisconnectState | null = null;
  private lastAutoRetryAt = 0;
  private lastForwardAutoRetryAt = new Map<number, number>();
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
      this.setRemoteDisconnect(failure.server, failure.message);
    });

    // The backend websocket is the fastest, most reliable "backend unreachable"
    // signal. In SSH mode a dead tunnel keeps the forwarded local port open, so the
    // tunnel status can read 'active' for ~90s while the websocket stalls — leaving
    // the user stuck on the generic, non-actionable server overlay. React to the
    // websocket loss directly to drive SSH recovery instead of waiting on the slow
    // ssh-process-exit edge.
    effect(() => {
      const phase = this.serverConnection.state().phase;
      this.handleServerPhaseChange(phase);
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
    if (this._remoteRetrying() || this.onboardingStartup.startupConnectingServer()) {
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

    const token = ++this.cancelToken;
    this._remoteRetrying.set({ server: activeServer, localPort: activeServer.localPort, phaseOverride: null });

    try {
      const result = await this.withTimeout(
        this.onboardingConnection.reconnect(activeServer, { interactive: false }),
        RECONNECT_TIMEOUT_MS,
      );

      if (this.cancelToken !== token) {
        return;
      }

      if (result?.kind === 'success') {
        await this.handleReconnectionSuccess(activeServer, result, token);
        return;
      }

      this._remoteRetrying.set(null);
      this._remoteDisconnect.set({
        server: activeServer,
        localPort: activeServer.localPort,
        message: result?.message || disconnectMessage,
      });
    } catch {
      if (this.cancelToken !== token) {
        return;
      }
      this._remoteRetrying.set(null);
      this._remoteDisconnect.set({
        server: activeServer,
        localPort: activeServer.localPort,
        message: disconnectMessage,
      });
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return Promise.race([
      promise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
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

  clearRemoteDisconnect(): void {
    ++this.cancelToken;
    this._remoteRetrying.set(null);
    this._remoteDisconnect.set(null);
    this.savedDisconnect = null;
    this.previousRemoteStatus = null;
    this.previousRemoteServerId = null;
    this.remoteHydrated = false;
  }

  async startMonitoring(): Promise<void> {
    if (this.pollTimer !== null) {
      return;
    }

    if (!(await this.sshForwardsService.isSupported())) {
      this.stopMonitoring();
      return;
    }

    await this.refreshNow();
    this.pollTimer = window.setInterval(() => {
      void this.refreshNow();
    }, POLL_INTERVAL_MS);
  }

  stopMonitoring() {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.clearServerDisconnectGraceTimer();
  }

  async refreshNow(): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return;
    }

    this.refreshInFlight = true;
    try {
      await this.refreshSavedForwards();
      await this.refreshRemoteTunnel();
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
    if (!current || this._remoteRetrying()) {
      return;
    }

    this.savedDisconnect = current;
    this._remoteDisconnect.set(null);

    const token = ++this.cancelToken;
    this._remoteRetrying.set({ server: current.server, localPort: current.localPort, phaseOverride: null });

    try {
      const result = await this.onboardingConnection.reconnect(current.server, {
        interactive: true,
        password: options.password,
        passphrase: options.passphrase,
      });

      if (this.cancelToken !== token) {
        return;
      }

      if (result.kind === 'success') {
        await this.handleReconnectionSuccess(current.server, result, token);
        return;
      }

      this._remoteRetrying.set(null);
      this.savedDisconnect = null;
      this._remoteDisconnect.set({
        server: current.server,
        localPort: current.localPort,
        message: result.message || 'Could not reconnect to the remote Elevenex server.',
      });
    } catch {
      if (this.cancelToken !== token) {
        return;
      }
      this._remoteRetrying.set(null);
      this.savedDisconnect = null;
      this._remoteDisconnect.set({
        server: current.server,
        localPort: current.localPort,
        message: 'Could not reconnect to the remote Elevenex server.',
      });
    }
  }

  private async handleReconnectionSuccess(
    server: SavedServer,
    result: OnboardingConnectionSuccess,
    token: number,
  ): Promise<void> {
    this._remoteRetrying.set({
      server,
      localPort: server.localPort,
      phaseOverride: CONNECTING_PHASES.length,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 350));

    if (this.cancelToken !== token) {
      return;
    }

    const nextServer: SavedServer = {
      ...server,
      localPort: result.localPort,
      installStatus: result.installStatus,
      lastConnectedAt: new Date().toISOString(),
    };
    this.onboardingState.saveServer(nextServer);

    // Automatically restore previously active forwards to avoid redundant banners
    await this.reconnectAllDisconnectedForwards();

    // Only show the startup prompt if we didn't just restore everything (it checks for non-active forwards)
    await this.onboardingStartup.prepareStartupPortForwardPrompt(nextServer);

    this.onboardingStartup.clearStartupFailure();
    this._remoteRetrying.set(null);
    this.savedDisconnect = null;
    this.previousRemoteServerId = nextServer.id;
    this.previousRemoteStatus = 'active';
    this.remoteHydrated = true;
    this.navigationService.refreshTree();
  }

  cancelRemoteConnection(): void {
    ++this.cancelToken;
    this._remoteRetrying.set(null);
    if (this.savedDisconnect) {
      this._remoteDisconnect.set(this.savedDisconnect);
      this.savedDisconnect = null;
    }
  }

  private async reconnectSavedForward(id: number): Promise<void> {
    if (this.reconnectingSavedIds.has(id)) {
      return;
    }

    this.reconnectingSavedIds.add(id);
    this.syncDisconnectedForwardsBanner();
    try {
      await firstValueFrom(this.sshForwardsService.start(id));
      this.previousSavedStatuses.set(id, 'active');
      this.disconnectedSavedForwards.delete(id);
    } finally {
      this.reconnectingSavedIds.delete(id);
      this.syncDisconnectedForwardsBanner();
    }
  }

  private async refreshSavedForwards(): Promise<void> {
    const [allForwards, activeProjects] = await Promise.all([
      this.sshForwardsService.getAllOnce().catch(() => []),
      firstValueFrom(this.projectsService.getAll('active')).catch(() => []),
    ]);
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
        const lastRetry = this.lastForwardAutoRetryAt.get(forward.id) || 0;
        const now = Date.now();
        if (this.previousRemoteStatus === 'active' && now - lastRetry > 30000) {
          this.lastForwardAutoRetryAt.set(forward.id, now);
          void this.reconnectSavedForward(forward.id);
        } else {
          this.disconnectedSavedForwards.set(forward.id, toDisconnectedForwardItem(forward));
          this.savedBannerVisible = true;
        }
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
      this.remoteHydrated = false;
      this.previousRemoteStatus = null;
      this.previousRemoteServerId = null;
      this._remoteDisconnect.set(null);
      return;
    }

    const activeServer = this.onboardingState.getActiveServer(snapshot);
    const api = getElectronSshForwardingApi();
    if (!activeServer || !api) {
      this.remoteHydrated = false;
      this.previousRemoteStatus = null;
      this.previousRemoteServerId = null;
      this._remoteDisconnect.set(null);
      return;
    }

    const runtime = await api.getState(activeServer.id);
    const currentStatus = runtime?.status ?? 'inactive';
    if (this.previousRemoteServerId !== activeServer.id) {
      this.previousRemoteServerId = activeServer.id;
      this.previousRemoteStatus = currentStatus;
      this.remoteHydrated = true;
      if (currentStatus === 'active') {
        this._remoteDisconnect.set(null);
      }
      return;
    }

    if (
      this.remoteHydrated
      && isLiveStatus(this.previousRemoteStatus)
      && isDisconnectedStatus(currentStatus)
    ) {
      // Attempt a silent auto-retry before showing the blocking overlay
      const now = Date.now();
      if (now - this.lastAutoRetryAt > POLL_INTERVAL_MS * 2) {
        this.lastAutoRetryAt = now;
        const token = ++this.cancelToken;
        try {
          const result = await this.onboardingConnection.reconnect(activeServer, { interactive: false });
          if (this.cancelToken === token && result.kind === 'success') {
            await this.handleReconnectionSuccess(activeServer, result, token);
            return;
          }
        } catch {
          // Fall through to showing the disconnect overlay
        }
      }

      this._remoteDisconnect.set({
        server: activeServer,
        localPort: activeServer.localPort,
        message:
          runtime?.lastError
          || `The Elevenex tunnel to ${activeServer.sshHost}:${ELEVENEX_REMOTE_PORT} disconnected.`,
      });
    } else if (currentStatus === 'active') {
      // Only trust an 'active' status to clear the overlay once the backend is
      // actually reachable again. A dead tunnel keeps the forwarded port (and thus
      // this status) 'active' for ~90s while the websocket stays down, so clearing
      // here unconditionally would wipe a websocket-driven recovery overlay.
      if (this.serverConnection.isInteractive()) {
        this._remoteDisconnect.set(null);
      }
    } else {
      const current = this._remoteDisconnect();
      if (current?.server.id === activeServer.id && runtime?.lastError) {
        this._remoteDisconnect.set({
          ...current,
          message: runtime.lastError,
        });
      }
    }

    this.previousRemoteStatus = currentStatus;
    this.remoteHydrated = true;
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
