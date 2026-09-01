import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucidePower, lucideTriangleAlert } from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';

import { ZardButtonComponent } from '@/shared/components/button';
import {
  BackendRuntimeService,
  BackendRuntimeStatus,
} from '@/shared/services/backend-runtime.service';
import { ServerConnectionService } from '@/shared/services/server-connection.service';

/** Stop waiting for the backend to come back after this long. */
const RESTART_TIMEOUT_MS = 90_000;

@Component({
  selector: 'app-backend-restart',
  imports: [NgIcon, ZardButtonComponent],
  templateUrl: './backend-restart.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  viewProviders: [provideIcons({ lucidePower, lucideTriangleAlert })],
})
export class BackendRestartComponent {
  private readonly backendRuntime = inject(BackendRuntimeService);
  private readonly serverConnection = inject(ServerConnectionService);

  readonly status = signal<BackendRuntimeStatus | null>(null);
  readonly restarting = signal(false);
  readonly restartSupported = computed(() => this.status()?.restartSupported === true);

  private reconnectBaseline = 0;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    void this.loadStatus();

    // The backend never answers "I am back" — it is gone by then. The reconnect
    // the socket makes on its own is the signal that the new process is up.
    effect(() => {
      const reconnects = this.serverConnection.reconnectCount();
      if (!this.restarting() || reconnects <= this.reconnectBaseline) {
        return;
      }

      this.settle();
      toast.success('Backend restarted.');
      void this.loadStatus();
    });

    inject(DestroyRef).onDestroy(() => this.clearTimeoutTimer());
  }

  async restart(): Promise<void> {
    if (this.restarting() || !this.restartSupported()) {
      return;
    }

    const confirmed = window.confirm(
      'Restart the Elevenex backend? Terminals keep running in tmux, but any agent run in progress is interrupted.',
    );
    if (!confirmed) {
      return;
    }

    this.reconnectBaseline = this.serverConnection.reconnectCount();
    this.restarting.set(true);

    try {
      await this.backendRuntime.restart();
    } catch {
      this.settle();
      toast.error('Could not restart the backend.');
      return;
    }

    this.clearTimeoutTimer();
    this.timeoutTimer = setTimeout(() => {
      this.settle();
      toast.error('The backend did not come back. Check the server, then reconnect.');
    }, RESTART_TIMEOUT_MS);
  }

  private async loadStatus(): Promise<void> {
    try {
      this.status.set(await this.backendRuntime.getStatus());
    } catch {
      // An older backend has no runtime endpoint at all, which is the same
      // situation as one that cannot restart itself: no button.
      this.status.set(null);
    }
  }

  private settle(): void {
    this.clearTimeoutTimer();
    this.restarting.set(false);
  }

  private clearTimeoutTimer(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }
}
