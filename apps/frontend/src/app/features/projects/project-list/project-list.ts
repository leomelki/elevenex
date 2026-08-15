import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArchive, lucideCalendarClock, lucideChevronRight, lucideFolder, lucidePlus, lucideRotateCcw, lucideSearch, lucideTrash2 } from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';

import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { ZardSkeletonComponent } from '@/shared/components/skeleton';
import { Project } from '@/shared/models/project.model';
import { OnboardingStateService } from '@/shared/services/onboarding-state.service';
import { NavigationService } from '@/shared/services/navigation.service';
import { ProjectListState, ProjectsService } from '@/shared/services/projects.service';
import { ProjectOnboardingWizard } from '@/features/projects/project-onboarding-wizard/project-onboarding-wizard';
import { FirstProjectPromptComponent } from '@/features/projects/first-project-prompt/first-project-prompt.component';

@Component({
  selector: 'app-project-list',
  imports: [
    NgIcon,
    ZardButtonComponent,
    ZardInputDirective,
    ZardSkeletonComponent,
    ProjectOnboardingWizard,
    FirstProjectPromptComponent,
  ],
  templateUrl: './project-list.html',
  host: { class: 'block flex-1 overflow-y-auto bg-background' },
  viewProviders: [provideIcons({ lucideArchive, lucideCalendarClock, lucideChevronRight, lucideFolder, lucidePlus, lucideRotateCcw, lucideSearch, lucideTrash2 })],
})
export class ProjectList implements OnInit {
  private projectsService = inject(ProjectsService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private onboardingState = inject(OnboardingStateService);
  private navigationService = inject(NavigationService);
projects = signal<Project[]>([]);
  loading = signal(true);
  showCreateWizard = signal(false);
  searchTerm = signal('');
  listState = signal<Exclude<ProjectListState, 'all'>>('active');
  busyProjectId = signal<number | null>(null);
  // Only SSH backends run on a genuinely separate machine that needs a port
  // forward to reach a project's dev server from this browser view. WSL
  // shares localhost with Windows the same way Local does, so it doesn't.
  showPortForwardStep = computed(() => this.onboardingState.snapshotState().mode === 'ssh');
  projectCountLabel = computed(() => {
    const count = this.projects().length;
    const stateLabel = this.listState() === 'archived' ? 'archived' : 'active';
    return `${count} ${stateLabel} project${count === 1 ? '' : 's'}`;
  });
  filteredProjects = computed(() => {
    const query = this.searchTerm().trim().toLocaleLowerCase();
    if (!query) {
      return this.projects();
    }

    return this.projects().filter(project => project.name.toLocaleLowerCase().includes(query));
  });
  hasNoSearchResults = computed(() =>
    !this.loading()
    && this.projects().length > 0
    && this.filteredProjects().length === 0,
  );

  ngOnInit() {
    this.route.queryParamMap.subscribe((params) => {
      if (params.get('create') === '1') {
        this.openCreateWizard();
      }
    });

    this.loadProjects();
  }

  loadProjects() {
    this.loading.set(true);
    this.projectsService.getAll(this.listState()).subscribe({
      next: (projects) => {
        this.projects.set(projects);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
      },
    });
  }

  selectListState(state: Exclude<ProjectListState, 'all'>) {
    if (this.listState() === state) {
      return;
    }

    this.listState.set(state);
    this.searchTerm.set('');
    this.loadProjects();
  }

  openCreateWizard() {
    this.showCreateWizard.set(true);
  }

  updateSearch(value: string) {
    this.searchTerm.set(value);
  }

  clearSearch() {
    this.searchTerm.set('');
  }

  closeCreateWizard() {
    this.showCreateWizard.set(false);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { create: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  handleWizardCompleted(project: Project) {
    if (this.listState() === 'active') {
      this.projects.update(list => list.some(entry => entry.id === project.id) ? list : [...list, project]);
    }
    this.showCreateWizard.set(false);
    void this.router.navigate(['/projects', project.id]);
  }

  navigateToProject(id: number) {
    this.router.navigate(['/projects', id]);
  }

  archiveProject(project: Project, event: Event) {
    event.stopPropagation();
    this.busyProjectId.set(project.id);
    this.projectsService.archive(project.id).subscribe({
      next: () => {
        this.projects.update(list => list.filter(entry => entry.id !== project.id));
        this.navigationService.refreshTree();
        toast.success('Project archived');
        this.busyProjectId.set(null);
      },
      error: () => {
        toast.error('Could not archive project.');
        this.busyProjectId.set(null);
      },
    });
  }

  restoreProject(project: Project, event: Event) {
    event.stopPropagation();
    this.busyProjectId.set(project.id);
    this.projectsService.unarchive(project.id).subscribe({
      next: () => {
        this.projects.update(list => list.filter(entry => entry.id !== project.id));
        this.navigationService.refreshTree();
        toast.success('Project restored');
        this.busyProjectId.set(null);
      },
      error: () => {
        toast.error('Could not restore project.');
        this.busyProjectId.set(null);
      },
    });
  }

  deleteProject(project: Project, event: Event) {
    event.stopPropagation();
    if (!window.confirm(`Permanently delete "${project.name}"? This cannot be undone.`)) {
      return;
    }

    this.busyProjectId.set(project.id);
    this.projectsService.delete(project.id).subscribe({
      next: () => {
        this.projects.update(list => list.filter(entry => entry.id !== project.id));
        this.navigationService.refreshTree();
        toast.success('Project deleted');
        this.busyProjectId.set(null);
      },
      error: () => {
        toast.error('Could not delete project.');
        this.busyProjectId.set(null);
      },
    });
  }

  formatProjectDate(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return 'Unknown';
    }

    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    }).format(date);
  }
}
