import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

import {
  getElectronRemoteLinkApi,
  type RemoteLinkDeviceState,
  type RemoteLinkSharingState,
  type RemoteLinkTransport,
} from '@/shared/runtime/electron-remote-link';
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

    void this.refresh();

    const unsubscribeSharing = this.api.onSharingChanged(state => this.sharingState.set(state));
    const unsubscribeStatus = this.api.onStatusChanged(state => {
      this.devicesState.update(devices =>
        devices.map(device => (device.id === state.id ? state : device)),
      );
      // A link that dropped must stop the window from treating its loopback
      // port as a live backend, otherwise sockets reconnect into a dead port.
      const paired = this.onboardingState.getPairedState();
      if (paired?.id === state.id && state.status !== 'connected') {
        this.onboardingState.clearPairedConnection();
      }
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
    const [sharing, devices] = await Promise.all([this.api.getSharing(), this.api.list()]);
    this.sharingState.set(sharing);
    this.devicesState.set(devices);
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
  async connect(id: number): Promise<RemoteLinkDeviceState> {
    if (!this.api) {
      throw new Error('Remote links are only available in the desktop app.');
    }

    return this.withBusy(async () => {
      const device = await this.api!.connect(id);
      if (!device.localPort) {
        throw new Error('The link connected but did not report a local port.');
      }
      this.onboardingState.setPairedState({
        id: device.id,
        name: device.name,
        localPort: device.localPort,
      });
      await this.refresh();
      return device;
    });
  }

  async disconnect(id: number): Promise<void> {
    if (!this.api) {
      return;
    }
    await this.api.disconnect(id);
    if (this.onboardingState.getPairedState()?.id === id) {
      this.onboardingState.clearPairedConnection();
    }
    await this.refresh();
  }

  private async withBusy<T>(work: () => Promise<T>): Promise<T> {
    this.busyState.set(true);
    try {
      return await work();
    } finally {
      this.busyState.set(false);
    }
  }
}
