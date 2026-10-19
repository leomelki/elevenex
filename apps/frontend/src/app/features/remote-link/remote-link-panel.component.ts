import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideCopy,
  lucideGlobe,
  lucideLaptop,
  lucidePlug,
  lucideRefreshCw,
  lucideServer,
  lucideTerminal,
  lucideTrash2,
  lucideTriangleAlert,
} from '@ng-icons/lucide';

import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import {
  pairingCodeTransport,
  type RemoteLinkDeviceState,
  type RemoteLinkTransport,
} from '@/shared/runtime/electron-remote-link';
import { OnboardingStateService } from '@/shared/services/onboarding-state.service';

import { RemoteLinkService } from './remote-link.service';

/**
 * Both halves of a remote link in one surface: sharing this machine's backend,
 * and connecting to a machine that shares one.
 *
 * Deliberately together — pairing is a two-device action, and the user is
 * usually looking at one screen while thinking about the other.
 */
@Component({
  selector: 'app-remote-link-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, NgIcon, ZardButtonComponent, ZardInputDirective],
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideCopy,
      lucideGlobe,
      lucideLaptop,
      lucidePlug,
      lucideRefreshCw,
      lucideServer,
      lucideTerminal,
      lucideTrash2,
      lucideTriangleAlert,
    }),
  ],
  templateUrl: './remote-link-panel.component.html',
})
export class RemoteLinkPanelComponent {
  private readonly service = inject(RemoteLinkService);
  private readonly onboardingState = inject(OnboardingStateService);

  /**
   * Emits the device the window was just pointed at. The host decides what a
   * switch means for it — bringing the link up is not enough on its own, since
   * the workspace around it still has to be re-mounted onto the new backend.
   */
  readonly connected = output<RemoteLinkDeviceState>();

  protected readonly supported = this.service.supported;
  protected readonly sharing = this.service.sharing;
  protected readonly devices = this.service.devices;
  protected readonly busy = this.service.busy;

  // Peer-to-peer by default: it is the only one of the three that needs neither
  // a server to run nor a network the other machine can already reach.
  protected readonly transport = signal<RemoteLinkTransport>('p2p');
  protected readonly relayUrl = signal('');
  protected readonly directPort = signal(11123);
  protected readonly sshHost = signal('');
  protected readonly sshUser = signal('');
  protected readonly sshPort = signal(22);
  // Null picks a free-looking port on the server and keeps it across restarts.
  protected readonly sshRelayPort = signal<number | null>(null);
  protected readonly sshIdentityFile = signal('');
  protected readonly pairingCode = signal<string | null>(null);
  protected readonly codeCopied = signal(false);
  protected readonly enteredCode = signal('');
  protected readonly deviceName = signal('');
  protected readonly deviceSshUser = signal('');
  protected readonly deviceSshIdentityFile = signal('');
  /** An SSH-relayed code needs a login on this side too, so the form asks for one. */
  protected readonly enteredCodeIsSsh = computed(() => pairingCodeTransport(this.enteredCode()) === 'ssh');
  protected readonly error = signal<string | null>(null);
  protected readonly connectingId = signal<number | null>(null);

  /**
   * The device *this window* is actually pointed at.
   *
   * A link being up says nothing about where the window sends its requests: the
   * link is owned by the main process and outlives any one window, so a reload
   * or a second window finds it already connected while still talking to its
   * own backend. Only this tells the two apart.
   */
  protected readonly activeDeviceId = computed(() => {
    const snapshot = this.onboardingState.snapshotState();
    if (snapshot.mode !== 'paired' || !snapshot.paired?.localPort) {
      return null;
    }
    return snapshot.paired.id;
  });

  protected isActiveDevice(device: RemoteLinkDeviceState): boolean {
    return this.activeDeviceId() === device.id && device.status === 'connected';
  }

  /**
   * Connecting is offered for every device this window is not already on, even
   * one whose link is up — that is the only way to claim an existing link, and
   * connect() is a no-op on the main-process side when it already is.
   */
  protected connectLabel(device: RemoteLinkDeviceState): string {
    if (this.isActiveDevice(device)) {
      return 'Connected';
    }
    return device.status === 'connected' ? 'Open' : 'Connect';
  }

  protected readonly sharingSummary = computed(() => {
    const sharing = this.sharing();
    if (!sharing.enabled) {
      return 'Off — this machine is not reachable from other devices.';
    }
    switch (sharing.status) {
      case 'connected':
        return sharing.connectedPeers === 1
          ? 'One device is connected.'
          : `${sharing.connectedPeers} devices are connected.`;
      case 'waiting':
        return 'Waiting for a device to connect.';
      case 'reconnecting':
        if (sharing.transport === 'ssh') {
          return sharing.error ? `Reconnecting to the SSH server — ${sharing.error}` : 'Reconnecting to the SSH server…';
        }
        return sharing.transport === 'relay' ? 'Reconnecting to the relay…' : 'Reconnecting…';
      case 'error':
        return sharing.error ?? 'Sharing hit an error.';
      default:
        return 'Starting…';
    }
  });

  protected setTransport(value: RemoteLinkTransport): void {
    this.transport.set(value);
  }

  // A hand-rolled 4-way segmented control (rather than a variable-length row of
  // buttons) so it can never wrap unpredictably in the narrow sidebar popover
  // this panel is embedded in.
  protected transportOptionClass(value: RemoteLinkTransport): string {
    const base =
      'flex flex-col items-center justify-center gap-1 rounded-md px-1 py-1.5 text-center text-[11px] font-medium leading-tight transition-colors';
    return this.transport() === value
      ? `${base} bg-background text-foreground shadow-sm`
      : `${base} text-muted-foreground hover:text-foreground`;
  }

  // A p2p link has no endpoint to show: naming the brokers would be noise, and
  // there is no address for the user to check.
  protected transportSummary(device: RemoteLinkDeviceState): string {
    switch (device.transport) {
      case 'relay':
        return `Via relay · ${device.endpoint}`;
      case 'direct':
        return `Direct · ${device.endpoint}`;
      case 'ssh':
        return `Via SSH · ${this.sshServerLabel(device.endpoint)}`;
      default:
        return 'Peer-to-peer';
    }
  }

  protected connectedPathLabel(device: RemoteLinkDeviceState): string {
    if (device.path === 'direct') {
      return 'Peer-to-peer';
    }
    return device.transport === 'ssh' ? 'Via SSH' : 'Via relay';
  }

  // `ssh://user@host:22/40000` → `user@host`: the relay port is plumbing.
  private sshServerLabel(endpoint: string): string {
    try {
      const url = new URL(endpoint);
      const user = url.username ? `${decodeURIComponent(url.username)}@` : '';
      const port = url.port && url.port !== '22' ? `:${url.port}` : '';
      return `${user}${url.hostname}${port}`;
    } catch {
      return endpoint;
    }
  }

  protected async pickSharingIdentityFile(): Promise<void> {
    const path = await this.service.pickIdentityFile();
    if (path) {
      this.sshIdentityFile.set(path);
    }
  }

  protected async pickDeviceIdentityFile(): Promise<void> {
    const path = await this.service.pickIdentityFile();
    if (path) {
      this.deviceSshIdentityFile.set(path);
    }
  }

  protected async enableSharing(): Promise<void> {
    this.error.set(null);
    try {
      await this.service.enableSharing({
        transport: this.transport(),
        relayUrl: this.relayUrl().trim(),
        directPort: this.directPort(),
        ...(this.transport() === 'ssh'
          ? {
              ssh: {
                host: this.sshHost().trim(),
                port: Number(this.sshPort()) || 22,
                user: this.sshUser().trim(),
                relayPort: Number(this.sshRelayPort()) || undefined,
                identityFile: this.sshIdentityFile().trim(),
              },
            }
          : {}),
      });
      await this.revealCode();
    } catch (error) {
      this.error.set(this.messageFor(error));
    }
  }

  protected async disableSharing(): Promise<void> {
    this.error.set(null);
    this.pairingCode.set(null);
    try {
      await this.service.disableSharing();
    } catch (error) {
      this.error.set(this.messageFor(error));
    }
  }

  protected async revealCode(): Promise<void> {
    this.pairingCode.set(await this.service.readSharingCode());
  }

  protected async regenerateCode(): Promise<void> {
    this.error.set(null);
    try {
      this.pairingCode.set(await this.service.regenerateCode());
      this.codeCopied.set(false);
    } catch (error) {
      this.error.set(this.messageFor(error));
    }
  }

  protected async copyCode(): Promise<void> {
    const code = this.pairingCode();
    if (!code) {
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      this.codeCopied.set(true);
      setTimeout(() => this.codeCopied.set(false), 2000);
    } catch {
      // Clipboard access can be refused; the code is on screen to copy by hand.
    }
  }

  protected async addDevice(): Promise<void> {
    this.error.set(null);
    const code = this.enteredCode().trim();
    if (!code) {
      return;
    }
    try {
      const ssh = this.enteredCodeIsSsh()
        ? { user: this.deviceSshUser().trim(), identityFile: this.deviceSshIdentityFile().trim() }
        : undefined;
      await this.service.addDevice(code, this.deviceName().trim(), ssh);
      this.enteredCode.set('');
      this.deviceName.set('');
      this.deviceSshUser.set('');
      this.deviceSshIdentityFile.set('');
    } catch (error) {
      this.error.set(this.messageFor(error));
    }
  }

  protected async connect(id: number): Promise<void> {
    this.error.set(null);
    this.connectingId.set(id);
    try {
      this.connected.emit(await this.service.connect(id));
    } catch (error) {
      this.error.set(this.messageFor(error));
    } finally {
      this.connectingId.set(null);
    }
  }

  protected async removeDevice(id: number): Promise<void> {
    this.error.set(null);
    try {
      await this.service.removeDevice(id);
    } catch (error) {
      this.error.set(this.messageFor(error));
    }
  }

  // IPC rejections arrive as plain Errors whose message is the one the main
  // process wrote for the user; anything else gets a generic fallback.
  private messageFor(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message.replace(/^Error invoking remote method '[^']*':\s*/, '');
    }
    return 'Something went wrong with the remote link.';
  }
}
