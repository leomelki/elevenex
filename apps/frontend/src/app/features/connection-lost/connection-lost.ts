import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideLoader,
  lucideRefreshCw,
  lucideSettings,
  lucideTriangleAlert,
  lucideWifiOff,
} from '@ng-icons/lucide';

import { ZardButtonComponent } from '@/shared/components/button';
import { OnboardingConnectionService } from '@/shared/services/onboarding-connection.service';
import { SavedServer } from '@/shared/models/onboarding.model';
import { OnboardingStateService } from '@/shared/services/onboarding-state.service';
import { OnboardingStartupService } from '@/shared/services/onboarding-startup.service';
import { CONNECTING_PHASES, remoteInstallPhaseToIndex } from '@/shared/services/ssh-runtime-recovery.service';

@Component({
  selector: 'app-connection-lost',
  imports: [NgIcon, ZardButtonComponent],
  templateUrl: './connection-lost.html',
  styleUrl: './connection-lost.scss',
  host: { class: 'block flex-1 overflow-y-auto' },
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideLoader,
      lucideWifiOff,
      lucideTriangleAlert,
      lucideRefreshCw,
      lucideSettings,
    }),
  ],
})
export class ConnectionLost implements OnInit {
  private readonly router = inject(Router);
  private readonly startupService = inject(OnboardingStartupService);
  private readonly connectionService = inject(OnboardingConnectionService);
  private readonly onboardingState = inject(OnboardingStateService);

  readonly failure = this.startupService.startupFailure;
  readonly retrying = signal(false);
  readonly connectingPhaseIndex = computed(() =>
    this.retrying() ? remoteInstallPhaseToIndex(this.connectionService.currentPhase()) : 0,
  );
  readonly connectingPhases = CONNECTING_PHASES;

  readonly authLabel = computed(() => {
    const f = this.failure();
    if (!f) return '';
    switch (f.server.authMode) {
      case 'agent': return 'SSH config / agent';
      case 'key': return 'Private key';
      case 'password': return 'Password';
    }
  });

  private cancelToken = 0;

  ngOnInit() {
    if (!this.failure()) {
      this.router.navigate(['/']);
    }
  }

  async retry() {
    const f = this.failure();
    if (!f || this.retrying()) return;

    const token = ++this.cancelToken;
    this.retrying.set(true);

    const result = await this.connectionService.reconnect(f.server);

    if (this.cancelToken !== token) return;

    if (result.kind === 'success') {
      await new Promise<void>((resolve) => setTimeout(resolve, 350));

      if (this.cancelToken !== token) return;

      const nextServer: SavedServer = {
        ...f.server,
        localPort: result.localPort,
        installStatus: result.installStatus,
        lastConnectedAt: new Date().toISOString(),
      };
      this.onboardingState.saveServer(nextServer);
      await this.startupService.prepareStartupPortForwardPrompt(nextServer);
      this.startupService.clearStartupFailure();
      this.retrying.set(false);
      this.router.navigate(['/']);
      return;
    }

    this.retrying.set(false);
    this.startupService.setStartupFailure({
      server: f.server,
      message: result.message || 'Could not connect to the SSH server.',
    });
  }

  cancelRetry() {
    ++this.cancelToken;
    this.retrying.set(false);
  }

  changeConfig() {
    this.startupService.clearStartupFailure();
    this.onboardingState.clearActiveServer();
    this.onboardingState.setCurrentStep('ssh');
    this.router.navigate(['/onboarding']);
  }
}
