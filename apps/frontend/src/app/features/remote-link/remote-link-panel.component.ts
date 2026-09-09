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
  lucideTrash2,
  lucideTriangleAlert,
} from '@ng-icons/lucide';

import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import type { RemoteLinkDeviceState, RemoteLinkTransport } from '@/shared/runtime/electron-remote-link';

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
      lucideTrash2,
      lucideTriangleAlert,
    }),
  ],
  templateUrl: './remote-link-panel.component.html',
})
export class RemoteLinkPanelComponent {
  private readonly service = inject(RemoteLinkService);

  readonly connected = output<void>();

  protected readonly supported = this.service.supported;
  protected readonly sharing = this.service.sharing;
  protected readonly devices = this.service.devices;
  protected readonly busy = this.service.busy;

  // Peer-to-peer by default: it is the only one of the three that needs neither
  // a server to run nor a network the other machine can already reach.
  protected readonly transport = signal<RemoteLinkTransport>('p2p');
  protected readonly relayUrl = signal('');
  protected readonly directPort = signal(11123);
  protected readonly pairingCode = signal<string | null>(null);
  protected readonly codeCopied = signal(false);
  protected readonly enteredCode = signal('');
  protected readonly deviceName = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly connectingId = signal<number | null>(null);

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

  // A hand-rolled 3-way segmented control (rather than a variable-length row of
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
      default:
        return 'Peer-to-peer';
    }
  }

  protected async enableSharing(): Promise<void> {
    this.error.set(null);
    try {
      await this.service.enableSharing({
        transport: this.transport(),
        relayUrl: this.relayUrl().trim(),
        directPort: this.directPort(),
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
      await this.service.addDevice(code, this.deviceName().trim());
      this.enteredCode.set('');
      this.deviceName.set('');
    } catch (error) {
      this.error.set(this.messageFor(error));
    }
  }

  protected async connect(id: number): Promise<void> {
    this.error.set(null);
    this.connectingId.set(id);
    try {
      await this.service.connect(id);
      this.connected.emit();
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
