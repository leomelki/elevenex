import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import {
  getElectronRemoteLinkApi,
  type RemoteLinkDeviceState,
  type RemoteLinkSharingState,
  type RemoteLinkTransport,
} from '@/shared/runtime/electron-remote-link';
import { awaitConnectionOperation } from '@/shared/runtime/connection-operation';
import { ServerConnectionService } from '@/shared/services/server-connection.service';
import { OnboardingStateService } from '@/shared/services/onboarding-state.service';

const EMPTY_SHARING: RemoteLinkSharingState = {
  configured: false,
  enabled: false,
  transport: null,
  endpoint: null,
  label: '',
  status: 'stopped',
  connectedPeers: 0,
  error: null,
};

/**
 * Renderer-side view of the remote links owned by the main process.
 *
 * Holds no credentials: the pairing key never crosses the bridge, and the code
 * (which *is* the credential) is fetched only when the user asks to see it, so
 * it is never cached in a signal.
 */
@Injectable({ providedIn: 'root' })
export class RemoteLinkService {
  private readonly onboardingState = inject(OnboardingStateService);
  private readonly serverConnection = inject(ServerConnectionService);
  private connectionGeneration = 0;
  private busyCount = 0;
  private refreshGeneration = 0;
  private statusRevision = 0;
  private sharingRevision = 0;
  private readonly deviceRevisions = new Map<number, number>();
  private readonly api = getElectronRemoteLinkApi();

  private readonly sharingState = signal<RemoteLinkSharingState>(EMPTY_SHARING);
  private readonly devicesState = signal<RemoteLinkDeviceState[]>([]);
  private readonly busyState = signal(false);

  readonly sharing = this.sharingState.asReadonly();
  readonly devices = this.devicesState.asReadonly();
  readonly busy = this.busyState.asReadonly();
  readonly supported = computed(() => this.api !== null);

  constructor() {
    if (!this.api) {
      return;
    }

    if (this.onboardingState.readSnapshot().mode === 'paired') {
      this.onboardingState.clearPairedConnection();
      this.serverConnection.setTransportAvailable(false);
    }
    effect(() => {
      const snapshot = this.onboardingState.snapshotState();
      const available = snapshot.mode !== 'paired' || (snapshot.remoteConnectionReady && !!snapshot.paired?.localPort);
      untracked(() => this.serverConnection.setTransportAvailable(available));
    });
    void this.refresh().catch(() => {});

    const unsubscribeSharing = this.api.onSharingChanged(state => {
      ++this.sharingRevision;
      this.sharingState.set(state);
    });
    const unsubscribeStatus = this.api.onStatusChanged(state => {
      this.deviceRevisions.set(state.id, ++this.statusRevision);
      this.devicesState.update(devices => devices.some(device => device.id === state.id)
        ? devices.map(device => device.id === state.id ? state : device)
        : [...devices, state]);

      const snapshot = this.onboardingState.readSnapshot();
      const paired = snapshot.paired;
      if (snapshot.mode !== 'paired' || paired?.id !== state.id) {
        return;
      }

      // A link that dropped must stop the window from treating its loopback
      // port as a live backend, otherwise sockets reconnect into a dead port.
      if (state.status !== 'connected' || !state.localPort) {
        this.onboardingState.clearPairedConnection();
        this.serverConnection.setTransportAvailable(false);
        return;
      }

      // ...and a link that came back must hand the window its backend again.
      // A p2p link re-establishes itself on its own, so without this a single
      // blip would leave the window on a paired desktop it never dials: the
      // switcher keeps the device's name, every request falls back to the local
      // origin, and the sidebar quietly fills with this machine's projects.
      this.onboardingState.markPairedConnected({
        id: state.id,
        name: state.name,
        localPort: state.localPort,
      });
      this.serverConnection.setTransportAvailable(true);
    });

    inject(DestroyRef).onDestroy(() => {
      unsubscribeSharing();
      unsubscribeStatus();
    });
  }

  async refresh(): Promise<void> {
    if (!this.api) {
      return;
    }
    const generation = ++this.refreshGeneration;
    const revision = this.statusRevision;
    const sharingRevision = this.sharingRevision;
    const [sharing, devices] = await Promise.all([this.api.getSharing(), this.api.list()]);
    if (generation !== this.refreshGeneration) return;
    if (sharingRevision === this.sharingRevision) this.sharingState.set(sharing);
    const latest = new Map(this.devicesState().map(device => [device.id, device]));
    this.devicesState.set(devices.map(device => (this.deviceRevisions.get(device.id) ?? 0) > revision
      ? latest.get(device.id) ?? device
      : device));
  }

  /** The pairing code. Fetched on demand only — see the class comment. */
  async readSharingCode(): Promise<string | null> {
    return this.api?.getSharingCode() ?? null;
  }

  async suggestedHost(): Promise<string> {
    return this.api?.suggestedHost() ?? '127.0.0.1';
  }

  async enableSharing(payload: {
    transport: RemoteLinkTransport;
    relayUrl?: string;
    directPort?: number;
  }): Promise<void> {
    if (!this.api) {
      return;
    }
    await this.withBusy(async () => {
      this.sharingState.set(await this.api!.enableSharing(payload));
    });
  }

  async disableSharing(): Promise<void> {
    if (!this.api) {
      return;
    }
    await this.withBusy(async () => {
      this.sharingState.set(await this.api!.disableSharing());
    });
  }

  async regenerateCode(): Promise<string | null> {
    if (!this.api) {
      return null;
    }
    const code = await this.api.regenerateCode();
    await this.refresh();
    return code;
  }

  async addDevice(code: string, name = ''): Promise<RemoteLinkDeviceState> {
    if (!this.api) {
      throw new Error('Remote links are only available in the desktop app.');
    }
    const device = await this.api.add({ code, name });
    await this.refresh();
    return device;
  }

  async removeDevice(id: number): Promise<void> {
    if (!this.api) {
      return;
    }
    await this.api.remove(id);
    await this.refresh();
  }

  /**
   * Brings the link up and points this window at it.
   *
   * The main process returns a loopback port that fronts the remote backend, so
   * from here on the window is configured exactly as it is for an SSH tunnel.
   */
  async connect(id: number, signal?: AbortSignal): Promise<RemoteLinkDeviceState> {
    if (!this.api) {
      throw new Error('Remote links are only available in the desktop app.');
    }

    const generation = ++this.connectionGeneration;
    const device = await this.withBusy(async () => {
      if (signal?.aborted) throw new Error('The connection was canceled.');
      const device = await awaitConnectionOperation(this.api!.connect(id), signal);
      if (signal?.aborted || generation !== this.connectionGeneration) throw new Error('The connection was canceled.');
      // The port outlives the session it fronts — it is opened when the link
      // starts and stays up across reconnects — so it is not on its own
      // evidence that anything is on the other end. Pointing the window at a
      // port whose session is down would show an empty workspace under the
      // device's name instead of a failure to connect.
      if (device.status !== 'connected' || !device.localPort) {
        throw new Error(device.error || 'The link did not finish connecting.');
      }
      this.onboardingState.setPairedState({
        id: device.id,
        name: device.name,
        localPort: device.localPort,
      });
      this.serverConnection.setTransportAvailable(true);
      // The server gateway, rather than a loopback port, gates HTTP and workspace actions.
      this.serverConnection.recheck();
      const verification = new AbortController();
      const cancel = () => verification.abort(signal?.reason);
      signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => verification.abort(new Error('The shared backend did not respond. Reconnection will continue automatically.')), 15000);
      try {
        await this.serverConnection.waitUntilInteractive(verification.signal);
        if (signal?.aborted || generation !== this.connectionGeneration) throw new Error('The connection was canceled.');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      }
      await this.refresh().catch(() => {});
      return device;
    });
    return device;
  }

  async disconnect(id: number): Promise<void> {
    if (!this.api) {
      return;
    }
    ++this.connectionGeneration;
    await this.api.disconnect(id);
    if (this.onboardingState.getPairedState()?.id === id) {
      this.onboardingState.clearPairedConnection();
    }
    await this.refresh();
  }

  private async withBusy<T>(work: () => Promise<T>): Promise<T> {
    ++this.busyCount;
    this.busyState.set(true);
    try {
      return await work();
    } finally {
      this.busyState.set(--this.busyCount > 0);
    }
  }
}
