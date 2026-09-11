import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideMonitorSmartphone, lucideUnlink } from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';

import { ZardButtonComponent } from '@/shared/components/button';

import { RemoteLinkService } from './remote-link.service';

/**
 * Always-visible bottom band for the sharing side of a remote link.
 *
 * While a paired desktop is actually on the other end, the machine is being
 * driven from elsewhere, so the owner needs an unmissable, non-dismissable
 * indicator plus a one-click kill switch. It disappears on its own when the
 * last peer goes away or sharing is stopped — there is nothing to dismiss.
 */
@Component({
  selector: 'app-remote-share-status-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, ZardButtonComponent],
  viewProviders: [provideIcons({ lucideMonitorSmartphone, lucideUnlink })],
  templateUrl: './remote-share-status-bar.component.html',
  host: { class: 'block shrink-0' },
})
export class RemoteShareStatusBarComponent {
  private readonly service = inject(RemoteLinkService);

  protected readonly sharing = this.service.sharing;
  protected readonly stopping = signal(false);

  /** Peers with a live session right now — 0 hides the band entirely. */
  protected readonly connectedPeers = computed(() => {
    const sharing = this.sharing();
    if (!sharing.enabled || sharing.status !== 'connected') {
      return 0;
    }
    return sharing.connectedPeers;
  });

  protected readonly peerSummary = computed(() => {
    const peers = this.connectedPeers();
    return peers === 1
      ? 'A paired desktop is remotely connected to this machine'
      : `${peers} paired desktops are remotely connected to this machine`;
  });

  protected async stopSharing(): Promise<void> {
    if (this.stopping()) {
      return;
    }
    this.stopping.set(true);
    try {
      await this.service.disableSharing();
      toast.success('Sharing stopped — paired desktops were disconnected.');
    } catch (error) {
      toast.error(this.messageFor(error));
    } finally {
      this.stopping.set(false);
    }
  }

  // IPC rejections arrive as plain Errors whose message is the one the main
  // process wrote for the user; anything else gets a generic fallback.
  private messageFor(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message.replace(/^Error invoking remote method '[^']*':\s*/, '');
    }
    return 'Could not stop sharing.';
  }
}
