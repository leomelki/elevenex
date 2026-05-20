import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowRight,
  lucideCheck,
  lucideChevronsRight,
  lucideHardDrive,
  lucideKeyRound,
  lucideLock,
  lucideRefreshCw,
  lucideServer,
  lucideShieldCheck,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';

import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { PathAutocompleteInputComponent } from '@/shared/components/path-autocomplete-input/path-autocomplete-input.component';
import { ELEVENEX_REMOTE_PORT } from '@/shared/constants/elevenex';
import { SavedServer, ServerAuthMode } from '@/shared/models/onboarding.model';
import { Project } from '@/shared/models/project.model';
import { ProjectsService } from '@/shared/services/projects.service';
import { OnboardingConnectionService } from '@/shared/services/onboarding-connection.service';
import { OnboardingStateService } from '@/shared/services/onboarding-state.service';
import { ProjectOnboardingWizard } from '@/features/projects/project-onboarding-wizard/project-onboarding-wizard';

@Component({
  selector: 'app-onboarding',
  imports: [NgIcon, ZardButtonComponent, ZardInputDirective, PathAutocompleteInputComponent, ProjectOnboardingWizard],
  templateUrl: './onboarding.html',
  host: { class: 'block flex-1 overflow-y-auto' },
  viewProviders: [
    provideIcons({
      lucideArrowRight,
      lucideCheck,
      lucideChevronsRight,
      lucideHardDrive,
      lucideKeyRound,
      lucideLock,
      lucideRefreshCw,
      lucideServer,
      lucideShieldCheck,
    }),
  ],
})
export class Onboarding implements OnInit {
  private readonly router = inject(Router);
  private readonly projectsService = inject(ProjectsService);
  private readonly onboardingState = inject(OnboardingStateService);
  private readonly connectionService = inject(OnboardingConnectionService);

  loading = signal(true);
  connecting = signal(false);
  sshSupported = signal(false);
  selectedMode = signal<'local' | 'ssh' | null>(null);
  activeStep = signal<'choice' | 'ssh' | 'install' | 'project'>('choice');
  connectionError = signal('');
  installMessage = signal('');
  existingProjectsCount = signal(0);

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
  readonly shouldShowPortForwardStep = computed(() => this.selectedMode() === 'ssh');
  readonly projectStepDescription = computed(() => this.selectedMode() === 'ssh'
    ? 'Create the project, add the repositories you want immediately, and optionally save any forwarded ports before you enter the app.'
    : 'Create the project and add the repositories you want immediately before you enter the app.');

  async ngOnInit() {
    const snapshot = this.onboardingState.readSnapshot();
    this.selectedMode.set(snapshot.mode);
    this.activeStep.set(snapshot.currentStep);

    if (snapshot.lastSshDefaults) {
      this.serverName.set(snapshot.lastSshDefaults.name);
      this.sshHost.set(snapshot.lastSshDefaults.sshHost);
      this.sshUser.set(snapshot.lastSshDefaults.sshUser ?? '');
      this.sshPort.set(snapshot.lastSshDefaults.sshPort);
      this.authMode.set(snapshot.lastSshDefaults.authMode);
      this.identityFilePath.set(snapshot.lastSshDefaults.identityFilePath ?? '');
    }

    this.sshSupported.set(await this.connectionService.isSupported());

    this.projectsService.getAll().subscribe({
      next: (projects) => {
        this.existingProjectsCount.set(projects.length);
        this.resolveInitialStep();
        this.loading.set(false);
      },
      error: () => {
        this.resolveInitialStep();
        this.loading.set(false);
      },
    });
  }

  chooseLocalMode() {
    this.selectedMode.set('local');
    this.onboardingState.setMode('local');
    if (this.existingProjectsCount() > 0) {
      this.onboardingState.markProjectHandoffAcknowledged();
      this.router.navigate(['/projects']);
      return;
    }

    this.activeStep.set('project');
    this.onboardingState.setCurrentStep('project');
  }

  chooseSshMode() {
    this.selectedMode.set('ssh');
    this.activeStep.set('ssh');
    this.connectionError.set('');
    this.installMessage.set('');
    this.onboardingState.setMode('ssh');
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

      const projects = await firstValueFrom(this.projectsService.getAll()).catch(() => []);
      this.existingProjectsCount.set(projects.length);

      if (projects.length > 0) {
        this.onboardingState.markProjectHandoffAcknowledged();
        await this.router.navigate(['/projects']);
      } else {
        this.activeStep.set('project');
      }
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

  async handleProjectCreated(project: Project) {
    this.onboardingState.markProjectHandoffAcknowledged();
    await this.router.navigate(['/projects', project.id]);
  }

  private resolveInitialStep() {
    const snapshot = this.onboardingState.readSnapshot();
    const activeServer = this.onboardingState.getActiveServer(snapshot);

    if (snapshot.mode === 'local') {
      this.selectedMode.set('local');
      if (this.existingProjectsCount() > 0) {
        this.onboardingState.markProjectHandoffAcknowledged();
        this.router.navigate(['/projects']);
        return;
      }
      this.activeStep.set('project');
      return;
    }

    if (snapshot.mode === 'ssh') {
      this.selectedMode.set('ssh');
      if (activeServer) {
        if (this.existingProjectsCount() > 0) {
          this.onboardingState.markProjectHandoffAcknowledged();
          this.router.navigate(['/projects']);
          return;
        }
        this.activeStep.set(snapshot.currentStep === 'install' ? 'install' : 'project');
        this.installMessage.set(
          snapshot.currentStep === 'install'
            ? 'The remote server is not reachable. Retry the connection.'
            : '',
        );
        return;
      }

      this.activeStep.set('ssh');
      return;
    }

    if (this.existingProjectsCount() > 0) {
      this.onboardingState.setMode('local');
      this.onboardingState.markProjectHandoffAcknowledged();
      this.router.navigate(['/projects']);
      return;
    }

    this.activeStep.set('choice');
  }

  private normalizedServerName() {
    return this.serverName().trim() || this.sshHost().trim() || 'Remote server';
  }
}
