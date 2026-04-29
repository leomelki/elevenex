import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
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
import { CONNECTING_PHASES } from '@/shared/services/ssh-runtime-recovery.service';

const PHASE_DURATIONS_MS = [3000, 5000, 7000, 5000];

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
export class ConnectionLost implements OnInit, OnDestroy {
  private readonly router = inject(Router);
  private readonly startupService = inject(OnboardingStartupService);
  private readonly connectionService = inject(OnboardingConnectionService);
  private readonly onboardingState = inject(OnboardingStateService);

  readonly failure = this.startupService.startupFailure;
  readonly retrying = signal(false);
  readonly connectingPhaseIndex = signal(0);
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
  private phaseTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit() {
    if (!this.failure()) {
      this.router.navigate(['/']);
    }
  }

  ngOnDestroy() {
    this.clearPhaseTimer();
  }

  async retry() {
    const f = this.failure();
    if (!f || this.retrying()) return;

    const token = ++this.cancelToken;
    this.retrying.set(true);
    this.connectingPhaseIndex.set(0);
    this.scheduleNextPhase(0, token);

    const result = await this.connectionService.reconnect(f.server);

    this.clearPhaseTimer();

    if (this.cancelToken !== token) return;

    if (result.kind === 'success') {
      this.connectingPhaseIndex.set(CONNECTING_PHASES.length);
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
    this.connectingPhaseIndex.set(0);
    this.startupService.setStartupFailure({
      server: f.server,
      message: result.message || 'Could not connect to the SSH server.',
    });
  }

  cancelRetry() {
    ++this.cancelToken;
    this.clearPhaseTimer();
    this.retrying.set(false);
    this.connectingPhaseIndex.set(0);
  }

  changeConfig() {
    this.startupService.clearStartupFailure();
    this.onboardingState.clearActiveServer();
    this.onboardingState.setCurrentStep('ssh');
    this.router.navigate(['/onboarding']);
  }

  private scheduleNextPhase(currentIndex: number, token: number): void {
    const duration = PHASE_DURATIONS_MS[currentIndex];
    if (duration === undefined) return;

    this.phaseTimer = setTimeout(() => {
      if (this.cancelToken !== token) return;
      this.connectingPhaseIndex.set(currentIndex + 1);
      this.scheduleNextPhase(currentIndex + 1, token);
    }, duration);
  }

  private clearPhaseTimer(): void {
    if (this.phaseTimer !== null) {
      clearTimeout(this.phaseTimer);
      this.phaseTimer = null;
    }
  }
}
