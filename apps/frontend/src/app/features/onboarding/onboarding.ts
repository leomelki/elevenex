import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowLeft,
  lucideArrowRight,
  lucideBot,
  lucideCheck,
  lucideChevronsRight,
  lucideCircleDot,
  lucideCode2,
  lucideCpu,
  lucideHardDrive,
  lucideKeyRound,
  lucideLock,
  lucideMonitor,
  lucideRefreshCw,
  lucideServer,
  lucideShieldCheck,
  lucideSparkles,
  lucideSquareTerminal,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';

import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { PathAutocompleteInputComponent } from '@/shared/components/path-autocomplete-input/path-autocomplete-input.component';
import { ELEVENEX_REMOTE_PORT } from '@/shared/constants/elevenex';
import { DefaultAgentProvider, DefaultClaudeSessionSurface } from '@/shared/models/app-settings.model';
import { SavedServer, ServerAuthMode } from '@/shared/models/onboarding.model';
import { getElectronWindowControlsApi } from '@/shared/runtime/electron-window-controls';
import { AppSettingsService } from '@/shared/services/app-settings.service';
import { OnboardingConnectionService } from '@/shared/services/onboarding-connection.service';
import { OnboardingStateService } from '@/shared/services/onboarding-state.service';

type OnboardingStep = 'connection' | 'ssh' | 'install' | 'agent' | 'claude-surface' | 'reminder';

@Component({
  selector: 'app-onboarding',
  imports: [NgIcon, ZardButtonComponent, ZardInputDirective, PathAutocompleteInputComponent],
  templateUrl: './onboarding.html',
  host: { class: 'block flex-1 overflow-y-auto' },
  viewProviders: [
    provideIcons({
      lucideArrowLeft,
      lucideArrowRight,
      lucideBot,
      lucideCheck,
      lucideChevronsRight,
      lucideCircleDot,
      lucideCode2,
      lucideCpu,
      lucideHardDrive,
      lucideKeyRound,
      lucideLock,
      lucideMonitor,
      lucideRefreshCw,
      lucideServer,
      lucideShieldCheck,
      lucideSparkles,
      lucideSquareTerminal,
    }),
  ],
})
export class Onboarding implements OnInit {
  private readonly router = inject(Router);
  private readonly onboardingState = inject(OnboardingStateService);
  private readonly connectionService = inject(OnboardingConnectionService);
  readonly appSettings = inject(AppSettingsService);

  loading = signal(true);
  connecting = signal(false);
  sshSupported = signal(false);
  isWindows = signal(false);
  wslSupported = signal(false);
  selectedMode = signal<'local' | 'ssh' | 'wsl' | null>(null);
  activeStep = signal<OnboardingStep>('connection');
  connectionError = signal('');
  installMessage = signal('');
  selectedAgent = signal<DefaultAgentProvider>('claude');
  selectedSurface = signal<DefaultClaudeSessionSurface>('claude-ui');

  serverName = signal('');
  sshHost = signal('');
  sshUser = signal('');
  sshPort = signal(22);
  authMode = signal<ServerAuthMode>('agent');
  password = signal('');
  identityFilePath = signal('');
  passphrase = signal('');

  private lastAttemptServerId = signal<number | null>(null);

  readonly canConnect = computed(() => {
    if (!this.sshHost().trim()) return false;
    if (this.authMode() === 'password' && !this.password().trim()) return false;
    if (this.authMode() === 'key' && !this.identityFilePath().trim()) return false;
    return Number.isInteger(this.sshPort()) && this.sshPort() > 0;
  });

  readonly serverSummary = computed(() => {
    const snapshot = this.onboardingState.readSnapshot();
    return this.onboardingState.getActiveServer(snapshot);
  });

  readonly wslSummary = computed(() => this.onboardingState.getWslState(this.onboardingState.readSnapshot()));

  readonly stepLabel = computed(() => {
    const step = this.activeStep();
    if (step === 'connection' || step === 'ssh' || step === 'install') {
      return 'Backend';
    }
    if (step === 'agent') {
      return 'Agent';
    }
    return this.selectedAgent() === 'claude' ? 'Claude surface' : 'Reminder';
  });

  async ngOnInit() {
    const snapshot = this.onboardingState.readSnapshot();
    this.selectedMode.set(snapshot.mode);

    if (snapshot.lastSshDefaults) {
      this.serverName.set(snapshot.lastSshDefaults.name);
      this.sshHost.set(snapshot.lastSshDefaults.sshHost);
      this.sshUser.set(snapshot.lastSshDefaults.sshUser ?? '');
      this.sshPort.set(snapshot.lastSshDefaults.sshPort);
      this.authMode.set(snapshot.lastSshDefaults.authMode);
      this.identityFilePath.set(snapshot.lastSshDefaults.identityFilePath ?? '');
    }

    this.sshSupported.set(await this.connectionService.isSupported());
    const environment = await getElectronWindowControlsApi()?.getEnvironment();
    this.isWindows.set(environment?.platform === 'win32');
    this.wslSupported.set(await this.connectionService.isWslSupported());
    await this.resolveInitialStep();
    this.loading.set(false);
  }

  async chooseLocalMode() {
    this.selectedMode.set('local');
    this.onboardingState.setMode('local');
    await this.loadBackendOnboarding();
  }

  chooseSshMode() {
    this.selectedMode.set('ssh');
    this.activeStep.set('ssh');
    this.connectionError.set('');
    this.installMessage.set('');
    this.onboardingState.setMode('ssh');
  }

  // Unlike SSH, WSL has nothing to configure first — clicking the card
  // connects immediately (auto-picking WSL's own default distro), the same
  // way chooseLocalMode() does for the local backend.
  async connectToWsl() {
    if (this.connecting()) {
      return;
    }

    this.selectedMode.set('wsl');
    this.connecting.set(true);
    this.connectionError.set('');
    this.installMessage.set('');

    const result = await this.connectionService.connectWsl();
    this.connecting.set(false);

    if (result.kind === 'success') {
      this.onboardingState.setWslState({
        distroName: result.distroName,
        localPort: result.localPort,
        installStatus: result.installStatus,
        lastConnectedAt: new Date().toISOString(),
      });
      await this.loadBackendOnboarding();
      return;
    }

    if (result.kind === 'missing-install') {
      this.activeStep.set('install');
      this.onboardingState.setCurrentStep('install');
      this.installMessage.set(result.message);
      return;
    }

    this.connectionError.set(result.message);
    toast.error(result.message);
  }

  selectAgent(agent: DefaultAgentProvider) {
    this.selectedAgent.set(agent);
  }

  continueFromAgent() {
    this.activeStep.set(this.selectedAgent() === 'claude' ? 'claude-surface' : 'reminder');
  }

  selectSurface(surface: DefaultClaudeSessionSurface) {
    this.selectedSurface.set(surface);
  }

  async pickIdentityFile() {
    const path = await this.connectionService.pickIdentityFile();
    if (path) {
      this.identityFilePath.set(path);
    }
  }

  async connectToServer() {
    if (!this.canConnect()) {
      return;
    }

    this.connecting.set(true);
    this.connectionError.set('');
    this.installMessage.set('');

    const result = await this.connectionService.connect({
      id: this.lastAttemptServerId() ?? undefined,
      name: this.normalizedServerName(),
      sshHost: this.sshHost(),
      sshUser: this.sshUser() || undefined,
      sshPort: this.sshPort(),
      authMode: this.authMode(),
      password: this.password(),
      identityFilePath: this.identityFilePath() || null,
      passphrase: this.passphrase(),
    });

    this.connecting.set(false);

    if (result.kind === 'success') {
      const now = new Date().toISOString();
      const server: SavedServer = {
        id: result.serverId,
        name: this.normalizedServerName(),
        sshHost: this.sshHost().trim(),
        sshUser: this.sshUser().trim() || null,
        sshPort: this.sshPort(),
        authMode: this.authMode(),
        identityFilePath: this.identityFilePath().trim() || null,
        localPort: result.localPort,
        remotePort: ELEVENEX_REMOTE_PORT,
        installStatus: 'available',
        createdAt: now,
        updatedAt: now,
        lastConnectedAt: now,
      };
      this.onboardingState.saveServer(server);
      this.password.set('');
      this.passphrase.set('');
      await this.loadBackendOnboarding();
      return;
    }

    if (result.kind === 'missing-install') {
      this.activeStep.set('install');
      this.onboardingState.setCurrentStep('install');
      this.installMessage.set(result.message);
      this.lastAttemptServerId.set(Date.now());
      return;
    }

    this.connectionError.set(result.message);
    toast.error(result.message);
  }

  retryConnection() {
    this.activeStep.set('ssh');
    this.onboardingState.setCurrentStep('ssh');
  }

  // Install-step actions dispatch by mode: SSH has a form to go back and edit /
  // resubmit; WSL has nothing to edit, so "edit" just returns to the connection
  // picker and "retry" re-attempts the same one-click connect.
  editCurrentConnection() {
    if (this.selectedMode() === 'wsl') {
      this.activeStep.set('connection');
      this.onboardingState.setCurrentStep('choice');
      return;
    }
    this.retryConnection();
  }

  async retryCurrentConnection() {
    if (this.selectedMode() === 'wsl') {
      await this.connectToWsl();
      return;
    }
    await this.connectToServer();
  }

  async finishOnboarding() {
    try {
      await this.appSettings.completeOnboarding({
        defaultAgentProvider: this.selectedAgent(),
        defaultClaudeSessionSurface:
          this.selectedAgent() === 'claude' ? this.selectedSurface() : undefined,
      });
      await this.router.navigate(['/projects']);
    } catch {
      toast.error('Could not finish onboarding.');
    }
  }

  private async resolveInitialStep() {
    const snapshot = this.onboardingState.readSnapshot();
    const activeServer = this.onboardingState.getActiveServer(snapshot);

    if (snapshot.mode === 'local') {
      this.selectedMode.set('local');
      await this.loadBackendOnboarding();
      return;
    }

    if (snapshot.mode === 'ssh') {
      this.selectedMode.set('ssh');
      if (activeServer) {
        if (snapshot.currentStep === 'install') {
          this.activeStep.set('install');
          this.installMessage.set('The remote server is not reachable. Retry the connection.');
          return;
        }
        await this.loadBackendOnboarding();
        return;
      }

      this.activeStep.set('ssh');
      return;
    }

    if (snapshot.mode === 'wsl') {
      this.selectedMode.set('wsl');
      if (snapshot.wsl) {
        if (snapshot.currentStep === 'install') {
          this.activeStep.set('install');
          this.installMessage.set('WSL is not reachable. Retry the connection.');
          return;
        }
        await this.loadBackendOnboarding();
        return;
      }

      this.activeStep.set('connection');
      return;
    }

    this.activeStep.set('connection');
  }

  private async loadBackendOnboarding() {
    try {
      const settings = await this.appSettings.load();
      this.selectedAgent.set(settings.defaultAgentProvider);
      this.selectedSurface.set(settings.defaultClaudeSessionSurface);
      if (settings.onboardingCompletedAt) {
        await this.router.navigate(['/projects']);
        return;
      }
      this.activeStep.set('agent');
    } catch {
      this.activeStep.set('connection');
      toast.error('Could not load backend onboarding settings.');
    }
  }

  private normalizedServerName() {
    return this.serverName().trim() || this.sshHost().trim() || 'Remote server';
  }
}
