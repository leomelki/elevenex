import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, effect, inject, input, OnInit, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowLeft,
  lucideArrowRight,
  lucideCheck,
  lucideChevronDown,
  lucideChevronUp,
  lucideFolderGit2,
  lucideGitBranch,
  lucidePlus,
  lucideRocket,
  lucideServer,
  lucideSparkles,
  lucideTrash2,
  lucideX,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';
import { toast } from 'ngx-sonner';

import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { PathAutocompleteInputComponent } from '@/shared/components/path-autocomplete-input/path-autocomplete-input.component';
import { Project } from '@/shared/models/project.model';
import { Repo } from '@/shared/models/repo.model';
import { SshForward } from '@/shared/models/ssh-forward.model';
import { NavigationService } from '@/shared/services/navigation.service';
import { ProjectsService } from '@/shared/services/projects.service';
import { ReposService } from '@/shared/services/repos.service';
import { CreateSshForwardPayload, SshForwardDefaults, SshForwardsService } from '@/shared/services/ssh-forwards.service';

type WizardStep = 'project' | 'repos' | 'ports' | 'review';

interface WizardRepoDraft {
  id: number;
  path: string;
  status: 'idle' | 'created' | 'error';
  error: string;
  repo: Repo | null;
}

interface WizardForwardDraft extends CreateSshForwardPayload {
  id: number;
  showAdvanced: boolean;
  status: 'idle' | 'created' | 'error';
  error: string;
  forward: SshForward | null;
}

const STEPS_WITH_PORTS: WizardStep[] = ['project', 'repos', 'ports', 'review'];
const STEPS_WITHOUT_PORTS: WizardStep[] = ['project', 'repos', 'review'];

@Component({
  selector: 'app-project-onboarding-wizard',
  imports: [NgIcon, ZardButtonComponent, ZardInputDirective, PathAutocompleteInputComponent],
  templateUrl: './project-onboarding-wizard.html',
  styleUrl: './project-onboarding-wizard.scss',
  viewProviders: [
    provideIcons({
      lucideArrowLeft,
      lucideArrowRight,
      lucideCheck,
      lucideChevronDown,
      lucideChevronUp,
      lucideFolderGit2,
      lucideGitBranch,
      lucidePlus,
      lucideRocket,
      lucideServer,
      lucideSparkles,
      lucideTrash2,
      lucideX,
    }),
  ],
})
export class ProjectOnboardingWizard implements OnInit {
  private readonly projectsService = inject(ProjectsService);
  private readonly reposService = inject(ReposService);
  private readonly sshForwardsService = inject(SshForwardsService);
  private readonly navigationService = inject(NavigationService);

  embedded = input(false);
  heading = input('Create a new project');
  subheading = input('Add repositories and optional forwarded ports in one flow.');
  ctaLabel = input('Create project');
  allowCancel = input(true);
  showPortForwardStep = input(true);

  cancelled = output<void>();
  completed = output<Project>();

  activeStep = signal<WizardStep>('project');
  projectName = signal('');
  repos = signal<WizardRepoDraft[]>([]);
  forwards = signal<WizardForwardDraft[]>([]);
  submitting = signal(false);
  submissionError = signal('');
  createdProject = signal<Project | null>(null);
  sshForwardingSupported = signal(false);
  sshDefaults = signal<SshForwardDefaults | null>(null);

  private nextRepoId = 1;
  private nextForwardId = 1;

  readonly steps = computed(() => this.showPortForwardStep() ? STEPS_WITH_PORTS : STEPS_WITHOUT_PORTS);
  readonly stepIndex = computed(() => this.steps().indexOf(this.activeStep()));
  readonly canGoBack = computed(() => this.stepIndex() > 0 && !this.submitting());
  readonly trimmedProjectName = computed(() => this.projectName().trim());
  readonly readyRepos = computed(() => this.repos().filter(repo => repo.path.trim()));
  readonly canAdvance = computed(() => {
    switch (this.activeStep()) {
      case 'project':
        return Boolean(this.trimmedProjectName());
      case 'repos':
        return this.readyRepos().length > 0;
      case 'ports':
        return this.validForwards().length === this.forwards().length;
      case 'review':
        return !this.submitting();
    }
  });
  readonly validForwards = computed(() => this.forwards().filter(forward => this.isForwardValid(forward)));
  readonly createdReposCount = computed(() => this.repos().filter(repo => repo.status === 'created').length);
  readonly createdForwardsCount = computed(() => this.forwards().filter(forward => forward.status === 'created').length);
  private readonly syncActiveStepWithPortForwardVisibility = effect(() => {
    if (!this.showPortForwardStep() && this.activeStep() === 'ports') {
      this.activeStep.set('review');
    }
  });

  async ngOnInit() {
    this.repos.set([this.createRepoDraft()]);
    this.sshDefaults.set(this.sshForwardsService.getLastDefaults());
    this.sshForwardingSupported.set(await this.sshForwardsService.isSupported());
  }

  close() {
    if (this.submitting()) {
      return;
    }

    this.cancelled.emit();
  }

  goToPreviousStep() {
    if (!this.canGoBack()) {
      return;
    }

    this.activeStep.set(this.steps()[this.stepIndex() - 1]);
  }

  goToNextStep() {
    if (!this.canAdvance() || this.activeStep() === 'review') {
      return;
    }

    this.activeStep.set(this.steps()[this.stepIndex() + 1]);
  }

  updateProjectName(value: string) {
    if (this.createdProject()) {
      return;
    }

    this.projectName.set(value);
  }

  addRepoRow() {
    this.repos.update(list => [...list, this.createRepoDraft()]);
  }

  removeRepoRow(id: number) {
    this.repos.update(list => list.length === 1 ? [this.createRepoDraft()] : list.filter(repo => repo.id !== id));
  }

  updateRepoPath(id: number, value: string) {
    this.repos.update(list => list.map(repo => repo.id === id
      ? { ...repo, path: value, error: '', status: repo.status === 'created' ? 'created' : 'idle' }
      : repo));
  }

  preferredRepoStartDirectory(repoPath: string) {
    if (repoPath.startsWith('~/')) {
      return '~';
    }

    if (!repoPath.includes('/')) {
      return undefined;
    }

    return repoPath.slice(0, repoPath.lastIndexOf('/')) || '/';
  }

  addForwardRow() {
    this.forwards.update(list => [...list, this.createForwardDraft()]);
  }

  removeForwardRow(id: number) {
    this.forwards.update(list => list.filter(forward => forward.id !== id));
  }

  updateForwardField<K extends keyof WizardForwardDraft>(id: number, key: K, value: WizardForwardDraft[K]) {
    this.forwards.update(list => list.map(forward => forward.id === id
      ? {
          ...forward,
          [key]: value,
          error: '',
          status: forward.status === 'created' ? 'created' : 'idle',
        }
      : forward));
  }

  toggleForwardAdvanced(id: number) {
    this.forwards.update(list => list.map(forward => forward.id === id
      ? { ...forward, showAdvanced: !forward.showAdvanced }
      : forward));
  }

  getStepLabel(step: WizardStep) {
    switch (step) {
      case 'project':
        return 'Project';
      case 'repos':
        return 'Repositories';
      case 'ports':
        return 'Port forwards';
      case 'review':
        return 'Review';
    }
  }

  getForwardSummary(forward: WizardForwardDraft) {
    const sshTarget = forward.sshUser?.trim()
      ? `${forward.sshUser.trim()}@${forward.sshHost.trim()}:${forward.sshPort}`
      : `${forward.sshHost.trim()}:${forward.sshPort}`;
    return `${sshTarget} • ${forward.bindAddress.trim()}:${forward.localPort} → ${forward.remoteHost.trim()}:${forward.remotePort}`;
  }

  asText(value: string | number) {
    return `${value}`;
  }

  async submit() {
    if (this.submitting()) {
      return;
    }

    this.submitting.set(true);
    this.submissionError.set('');

    try {
      const project = await this.ensureProjectCreated();
      await this.ensureReposCreated(project.id);
      await this.ensureForwardsCreated(project.id);

      this.navigationService.refreshTree();
      this.navigationService.revealProject(project.id);
      toast.success('Project ready');
      this.completed.emit(project);
    } catch (error) {
      const message = this.getErrorMessage(error, 'Could not finish creating the project.');
      this.submissionError.set(message);
      toast.error(message);
    } finally {
      this.submitting.set(false);
    }
  }

  private createRepoDraft(): WizardRepoDraft {
    return {
      id: this.nextRepoId++,
      path: '',
      status: 'idle',
      error: '',
      repo: null,
    };
  }

  private createForwardDraft(): WizardForwardDraft {
    const defaults = this.sshDefaults();
    const suggestedPort = this.suggestPort();
    return {
      id: this.nextForwardId++,
      name: `Port ${suggestedPort}`,
      sshHost: defaults?.sshHost ?? '',
      sshUser: defaults?.sshUser,
      sshPort: defaults?.sshPort ?? 22,
      bindAddress: defaults?.bindAddress ?? '127.0.0.1',
      localPort: suggestedPort,
      remoteHost: defaults?.remoteHost ?? '127.0.0.1',
      remotePort: suggestedPort,
      startImmediately: defaults?.startImmediately ?? true,
      showAdvanced: !defaults,
      status: 'idle',
      error: '',
      forward: null,
    };
  }

  private suggestPort() {
    const ports = this.forwards().map(forward => forward.localPort);
    let candidate = 3000;
    while (ports.includes(candidate)) {
      candidate += 1;
    }
    return candidate;
  }

  private isForwardValid(forward: WizardForwardDraft) {
    return Boolean(
      forward.name.trim()
      && forward.sshHost.trim()
      && forward.bindAddress.trim()
      && forward.remoteHost.trim()
      && Number.isInteger(forward.localPort)
      && Number.isInteger(forward.remotePort)
      && Number.isInteger(forward.sshPort)
      && forward.localPort > 0
      && forward.remotePort > 0
      && forward.sshPort > 0,
    );
  }

  private async ensureProjectCreated() {
    const existing = this.createdProject();
    if (existing) {
      return existing;
    }

    const project = await firstValueFrom(this.projectsService.create(this.trimmedProjectName()));
    this.createdProject.set(project);
    return project;
  }

  private async ensureReposCreated(projectId: number) {
    const drafts = this.repos().filter(repo => repo.path.trim());

    if (drafts.length === 0) {
      throw new Error('Add at least one repository before finishing.');
    }

    for (const repo of drafts) {
      if (repo.status === 'created') {
        continue;
      }

      try {
        const created = await firstValueFrom(this.reposService.add(projectId, repo.path.trim()));
        this.repos.update(list => list.map(entry => entry.id === repo.id
          ? { ...entry, status: 'created', error: '', repo: created }
          : entry));
      } catch (error) {
        const message = this.getErrorMessage(error, `Could not add ${repo.path.trim()}.`);
        this.repos.update(list => list.map(entry => entry.id === repo.id
          ? { ...entry, status: 'error', error: message }
          : entry));
        throw new Error(message);
      }
    }
  }

  private async ensureForwardsCreated(projectId: number) {
    for (const forward of this.forwards()) {
      if (forward.status === 'created') {
        continue;
      }

      if (!this.isForwardValid(forward)) {
        throw new Error('Each saved port forward needs a valid host and port configuration.');
      }

      try {
        const created = await firstValueFrom(this.sshForwardsService.create(projectId, {
          name: forward.name.trim(),
          sshHost: forward.sshHost.trim(),
          sshUser: forward.sshUser?.trim() || undefined,
          sshPort: forward.sshPort,
          bindAddress: forward.bindAddress.trim(),
          localPort: forward.localPort,
          remoteHost: forward.remoteHost.trim(),
          remotePort: forward.remotePort,
          startImmediately: forward.startImmediately,
        }));

        this.forwards.update(list => list.map(entry => entry.id === forward.id
          ? { ...entry, status: 'created', error: '', forward: created }
          : entry));
      } catch (error) {
        const message = this.getErrorMessage(error, `Could not save forward ${forward.name.trim()}.`);
        this.forwards.update(list => list.map(entry => entry.id === forward.id
          ? { ...entry, status: 'error', error: message }
          : entry));
        throw new Error(message);
      }
    }
  }

  private getErrorMessage(error: unknown, fallback: string) {
    if (error instanceof HttpErrorResponse) {
      return error.error?.message || fallback;
    }

    if (error instanceof Error) {
      return error.message || fallback;
    }

    return fallback;
  }
}
