import { A11yModule } from '@angular/cdk/a11y';
import { HttpErrorResponse } from '@angular/common/http';
import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  input,
  OnInit,
  output,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideArrowLeft,
  lucideArrowRight,
  lucideFolderOpen,
  lucideLoaderCircle,
  lucidePlus,
  lucideServer,
  lucideTrash2,
  lucideX,
} from '@ng-icons/lucide';
import { firstValueFrom, Subscription } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { toast } from 'ngx-sonner';

import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { RepositoryAutocompleteInputComponent } from '@/shared/components/repository-autocomplete-input/repository-autocomplete-input.component';
import { Project } from '@/shared/models/project.model';
import { Repo } from '@/shared/models/repo.model';
import { NavigationService } from '@/shared/services/navigation.service';
import { OnboardingStateService } from '@/shared/services/onboarding-state.service';
import { ProjectsService } from '@/shared/services/projects.service';
import { RepositorySuggestion, ReposService } from '@/shared/services/repos.service';

interface RepositoryDraft {
  id: number;
  path: string;
  validation: 'idle' | 'checking' | 'valid' | 'error';
  validatedPath: string;
  name: string;
  validationError: string;
  error: string;
  repo: Repo | null;
}

@Component({
  selector: 'app-project-create',
  imports: [
    A11yModule,
    NgIcon,
    ZardButtonComponent,
    ZardInputDirective,
    RepositoryAutocompleteInputComponent,
  ],
  templateUrl: './project-create.component.html',
  styleUrl: './project-create.component.scss',
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideArrowLeft,
      lucideArrowRight,
      lucideFolderOpen,
      lucideLoaderCircle,
      lucidePlus,
      lucideServer,
      lucideTrash2,
      lucideX,
    }),
  ],
})
export class ProjectCreateComponent implements OnInit {
  private readonly projectsService = inject(ProjectsService);
  private readonly reposService = inject(ReposService);
  private readonly navigationService = inject(NavigationService);
  private readonly onboardingState = inject(OnboardingStateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly pathInputs = viewChildren(RepositoryAutocompleteInputComponent);
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');
  private readonly validationTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly validationRequests = new Map<number, Subscription>();
  private nextRepoId = 1;

  readonly embedded = input(false);
  readonly heading = input('Select repositories');
  readonly subheading = input('Choose the code you want to work on.');
  readonly ctaLabel = input('Open project');
  readonly allowCancel = input(true);
  readonly existingProject = input<Pick<Project, 'id' | 'name' | 'agentInstructions'> | null>(null);
  readonly cancelled = output<void>();
  readonly completed = output<Project>();

  readonly repos = signal<RepositoryDraft[]>([]);
  readonly step = signal<'repos' | 'name'>('repos');
  readonly previouslyUsed = signal<RepositorySuggestion[]>([]);
  readonly previouslyUsedLoading = signal(false);
  readonly previouslyUsedError = signal(false);
  readonly availablePreviouslyUsed = computed(() =>
    this.previouslyUsed().filter(
      (repo) => !this.readyRepos().some((selected) => this.selectedPath(selected) === repo.path),
    ),
  );
  readonly projectName = signal('');
  readonly nameEdited = signal(false);
  readonly submitting = signal(false);
  readonly submissionError = signal('');
  readonly createdProject = signal<Project | null>(null);
  readonly readyRepos = computed(() => this.repos().filter((repo) => repo.path.trim()));
  readonly suggestedName = computed(() => {
    if (this.readyRepos().length !== 1) return '';
    const first = this.readyRepos()[0];
    if (!first) return '';
    const name = first.name || first.path.trim().split(/[\\/]/).filter(Boolean).at(-1) || '';
    return ['~', '.', '..'].includes(name) ? '' : name;
  });
  readonly projectDisplayName = computed(
    () =>
      this.existingProject()?.name ??
      this.createdProject()?.name ??
      (this.nameEdited() ? this.projectName() : this.suggestedName()),
  );
  readonly canContinue = computed(
    () =>
      !this.submitting() &&
      this.readyRepos().length > 0 &&
      this.readyRepos().every((repo) => repo.validation === 'valid' && !this.duplicateError(repo)),
  );
  readonly canSubmit = computed(
    () =>
      this.canContinue() &&
      (this.step() === 'name' || !!this.existingProject()) &&
      Boolean(this.projectDisplayName().trim()),
  );
  readonly locationLabel = computed(() => {
    const snapshot = this.onboardingState.snapshotState();
    if (snapshot.mode === 'paired') return snapshot.paired?.name || 'Paired desktop';
    if (snapshot.mode === 'ssh') {
      return (
        snapshot.servers?.find((server) => server.id === snapshot.activeServerId)?.name ||
        snapshot.lastSshDefaults?.sshHost ||
        'SSH server'
      );
    }
    if (snapshot.mode === 'wsl') return snapshot.wsl?.distroName || 'WSL';
    return snapshot.mode === 'local' ? 'This machine' : 'Connected machine';
  });

  constructor() {
    afterNextRender(() => this.pathInputs()[0]?.focus());
    this.destroyRef.onDestroy(() => {
      for (const id of new Set([
        ...this.validationTimers.keys(),
        ...this.validationRequests.keys(),
      ])) {
        this.cancelValidation(id);
      }
    });
  }

  ngOnInit() {
    this.addRepoRow();
    this.loadPreviouslyUsed();
  }

  loadPreviouslyUsed() {
    if (this.previouslyUsedLoading()) return;
    this.previouslyUsedLoading.set(true);
    this.previouslyUsedError.set(false);
    this.reposService
      .suggestRepositories('', 6)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (repos) => {
          this.previouslyUsed.set(repos);
          this.previouslyUsedLoading.set(false);
        },
        error: () => {
          this.previouslyUsedError.set(true);
          this.previouslyUsedLoading.set(false);
        },
      });
  }

  selectPreviouslyUsed(repo: RepositorySuggestion) {
    if (
      this.submitting() ||
      this.step() !== 'repos' ||
      this.readyRepos().some((selected) => this.selectedPath(selected) === repo.path)
    )
      return;
    let empty = this.repos().find((entry) => !entry.path.trim());
    if (!empty) {
      this.addRepoRow();
      empty = this.repos().at(-1);
    }
    if (!empty) return;
    this.updateRepoPath(empty.id, repo.path);
    this.validateRepo(empty.id);
  }

  excludedPaths(id: number) {
    return this.readyRepos()
      .filter((repo) => repo.id !== id)
      .map((repo) => this.selectedPath(repo));
  }

  nextStep() {
    if (!this.canContinue()) return;
    this.step.set('name');
    afterNextRender(() => this.nameInput()?.nativeElement.focus(), { injector: this.injector });
  }

  previousStep() {
    if (this.submitting()) return;
    this.step.set('repos');
    afterNextRender(() => this.pathInputs()[0]?.focus(), { injector: this.injector });
  }

  submitStep() {
    if (this.step() === 'repos' && !this.existingProject()) this.nextStep();
    else void this.submit();
  }

  close(event?: Event) {
    if (event?.defaultPrevented || this.submitting() || !this.allowCancel()) return;
    event?.preventDefault();
    this.cancelled.emit();
  }

  updateProjectName(value: string) {
    if (this.createdProject() || this.submitting()) return;
    this.nameEdited.set(true);
    this.projectName.set(value);
    this.submissionError.set('');
  }

  addRepoRow() {
    if (this.submitting()) return;
    this.repos.update((list) => [
      ...list,
      {
        id: this.nextRepoId++,
        path: '',
        validation: 'idle',
        validatedPath: '',
        name: '',
        validationError: '',
        error: '',
        repo: null,
      },
    ]);
  }

  removeRepoRow(id: number) {
    if (this.submitting() || this.repos().find((repo) => repo.id === id)?.repo) return;
    this.cancelValidation(id);
    this.repos.update((list) => list.filter((repo) => repo.id !== id));
    if (!this.repos().length) this.addRepoRow();
  }

  updateRepoPath(id: number, value: string) {
    const repo = this.repos().find((entry) => entry.id === id);
    if (!repo || repo.repo || this.submitting() || repo.path === value) return;
    this.cancelValidation(id);
    this.submissionError.set('');
    const pathLike = /[\\/]/.test(value) || value.trim() === '~';
    this.repos.update((list) =>
      list.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              path: value,
              validation: value.trim() && pathLike ? 'checking' : 'idle',
              validatedPath: '',
              name: '',
              validationError: '',
              error: '',
            }
          : entry,
      ),
    );
    if (value.trim() && pathLike) {
      this.validationTimers.set(
        id,
        setTimeout(() => {
          this.validationTimers.delete(id);
          this.validateRepo(id);
        }, 300),
      );
    }
  }

  validateRepo(id: number) {
    const repo = this.repos().find((entry) => entry.id === id);
    if (!repo?.path.trim() || repo.repo || repo.validation === 'valid' || this.submitting()) return;
    if (this.validationRequests.get(id) && !this.validationRequests.get(id)?.closed) return;
    this.cancelValidation(id);
    const requestedPath = repo.path;
    this.repos.update((list) =>
      list.map((entry) =>
        entry.id === id ? { ...entry, validation: 'checking', validationError: '' } : entry,
      ),
    );
    const subscription = this.reposService.validatePath(requestedPath.trim()).subscribe({
      next: (validated) => {
        if (this.destroyRef.destroyed) return;
        this.repos.update((list) =>
          list.map((entry) =>
            entry.id === id && entry.path === requestedPath
              ? {
                  ...entry,
                  validation: 'valid',
                  validatedPath: validated.path,
                  name: validated.name,
                }
              : entry,
          ),
        );
      },
      error: (error) => {
        if (this.destroyRef.destroyed) return;
        this.repos.update((list) =>
          list.map((entry) =>
            entry.id === id && entry.path === requestedPath
              ? {
                  ...entry,
                  validation: 'error',
                  validationError: this.errorMessage(
                    error,
                    'Could not check this folder. Try again.',
                  ),
                }
              : entry,
          ),
        );
      },
    });
    this.validationRequests.set(id, subscription);
  }

  duplicateError(repo: RepositoryDraft) {
    return repo.validatedPath &&
      this.readyRepos().some(
        (other) => other.id !== repo.id && other.validatedPath === repo.validatedPath,
      )
      ? 'This repository is already selected.'
      : '';
  }

  repoError(repo: RepositoryDraft) {
    return repo.validationError || this.duplicateError(repo) || repo.error;
  }

  async submit() {
    if (!this.canSubmit()) return;
    this.submitting.set(true);
    this.submissionError.set('');
    try {
      const target = this.existingProject();
      const project = target
        ? {
            ...target,
            createdAt: '',
            updatedAt: '',
            archivedAt: null,
            agentInstructions: target.agentInstructions ?? null,
          }
        : (this.createdProject() ??
          (await firstValueFrom(this.projectsService.create(this.projectDisplayName().trim()))));
      if (!target) this.createdProject.set(project);

      for (const repo of this.readyRepos()) {
        if (repo.repo) continue;
        try {
          const created = await firstValueFrom(
            this.reposService.add(project.id, repo.validatedPath),
          );
          this.repos.update((list) =>
            list.map((entry) =>
              entry.id === repo.id ? { ...entry, repo: created, error: '' } : entry,
            ),
          );
        } catch (error) {
          const message = this.errorMessage(error, 'Could not add this repository.');
          this.repos.update((list) =>
            list.map((entry) => (entry.id === repo.id ? { ...entry, error: message } : entry)),
          );
          throw new Error(message);
        }
      }
      this.navigationService.refreshTree();
      this.navigationService.revealProject(project.id);
      toast.success(target ? 'Repositories added' : 'Project ready');
      this.completed.emit(project);
    } catch (error) {
      this.submissionError.set(this.errorMessage(error, 'Could not open the project. Try again.'));
      // Successful links stay available if a later repository fails.
      if (this.createdProject()) this.navigationService.refreshTree();
    } finally {
      this.submitting.set(false);
    }
  }

  private cancelValidation(id: number) {
    const timer = this.validationTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.validationTimers.delete(id);
    this.validationRequests.get(id)?.unsubscribe();
    this.validationRequests.delete(id);
  }

  private selectedPath(repo: RepositoryDraft) {
    return repo.validatedPath || repo.path.trim().replace(/[\\/]+$/, '');
  }

  private errorMessage(error: unknown, fallback: string) {
    if (error instanceof HttpErrorResponse) {
      const message = error.error?.message;
      return Array.isArray(message)
        ? message.join(' ')
        : typeof message === 'string'
          ? message
          : fallback;
    }
    return error instanceof Error ? error.message : fallback;
  }
}
