import { Injectable, computed, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ELEVENEX_REMOTE_PORT } from '../constants/elevenex';
import { SavedServer } from '../models/onboarding.model';
import { SshForward, SshForwardStatus } from '../models/ssh-forward.model';
import { ElectronSshForwardRuntimeState, getElectronSshForwardingApi } from '../runtime/electron-ssh-forwarding';
import { RemoteInstallPhase } from '../runtime/electron-remote-server';
import { OnboardingConnectionService } from './onboarding-connection.service';
import { OnboardingStartupService } from './onboarding-startup.service';
import { OnboardingStateService } from './onboarding-state.service';
import { SshForwardsService } from './ssh-forwards.service';

const POLL_INTERVAL_MS = 3000;

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
  private readonly _remoteConnecting = signal<RemoteRuntimeConnectingState | null>(null);
  readonly disconnectedForwardsBanner = this._disconnectedForwardsBanner.asReadonly();
  readonly remoteDisconnect = this._remoteDisconnect.asReadonly();
  readonly remoteConnecting = this._remoteConnecting.asReadonly();

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

  readonly remoteConnectingPhaseIndex = computed(() =>
    remoteInstallPhaseToIndex(this.onboardingConnection.currentPhase()),
  );

  constructor(
    private readonly sshForwardsService: SshForwardsService,
    private readonly onboardingState: OnboardingStateService,
    private readonly onboardingConnection: OnboardingConnectionService,
    private readonly onboardingStartup: OnboardingStartupService,
  ) {}

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
    const failures: Array<{ id: number; name: string; error: Error }> = [];
    for (const forward of Array.from(this.disconnectedSavedForwards.values())) {
      try {
        await this.reconnectSavedForward(forward.id);
      } catch (error) {
        failures.push({
          id: forward.id,
          name: forward.name,
          error: error instanceof Error ? error : new Error('Could not reconnect the SSH forward.'),
        });
      }
    }

    return failures;
  }

  async retryRemoteConnection(): Promise<void> {
    const current = this._remoteDisconnect();
    if (!current || this._remoteConnecting()) {
      return;
    }

    this.savedDisconnect = current;
    this._remoteDisconnect.set(null);

    const token = ++this.cancelToken;
    this._remoteConnecting.set({ server: current.server, localPort: current.localPort, phaseIndex: 0 });

    try {
      const result = await this.onboardingConnection.reconnect(current.server);

      if (this.cancelToken !== token) {
        return;
      }

      if (result.kind === 'success') {
        this._remoteConnecting.set({
          server: current.server,
          localPort: current.localPort,
          phaseIndex: CONNECTING_PHASES.length,
        });

        await new Promise<void>((resolve) => setTimeout(resolve, 350));

        if (this.cancelToken !== token) {
          return;
        }

        const nextServer: SavedServer = {
          ...current.server,
          localPort: result.localPort,
          installStatus: result.installStatus,
          lastConnectedAt: new Date().toISOString(),
        };
        this.onboardingState.saveServer(nextServer);
        await this.onboardingStartup.prepareStartupPortForwardPrompt(nextServer);
        this._remoteConnecting.set(null);
        this.savedDisconnect = null;
        this.previousRemoteServerId = nextServer.id;
        this.previousRemoteStatus = 'active';
        this.remoteHydrated = true;
        return;
      }

      this._remoteConnecting.set(null);
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
      this._remoteConnecting.set(null);
      this.savedDisconnect = null;
      this._remoteDisconnect.set({
        server: current.server,
        localPort: current.localPort,
        message: 'Could not reconnect to the remote Elevenex server.',
      });
    }
  }

  cancelRemoteConnection(): void {
    ++this.cancelToken;
    this._remoteConnecting.set(null);
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
    const forwards = await this.sshForwardsService.getAllOnce().catch(() => []);
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
    if (this._remoteConnecting()) {
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
      this._remoteDisconnect.set({
        server: activeServer,
        localPort: activeServer.localPort,
        message:
          runtime?.lastError
          || `The Elevenex tunnel to ${activeServer.sshHost}:${ELEVENEX_REMOTE_PORT} disconnected.`,
      });
    } else if (currentStatus === 'active') {
      this._remoteDisconnect.set(null);
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
