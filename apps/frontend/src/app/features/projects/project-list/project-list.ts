import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCalendarClock, lucideChevronRight, lucideFolder, lucideFolderOpen, lucidePlus, lucideSearch } from '@ng-icons/lucide';

import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { ZardSkeletonComponent } from '@/shared/components/skeleton';
import { Project } from '@/shared/models/project.model';
import { OnboardingStateService } from '@/shared/services/onboarding-state.service';
import { ProjectsService } from '@/shared/services/projects.service';
import { ProjectOnboardingWizard } from '@/features/projects/project-onboarding-wizard/project-onboarding-wizard';

@Component({
  selector: 'app-project-list',
  imports: [
    NgIcon,
    ZardButtonComponent,
    ZardInputDirective,
    ZardSkeletonComponent,
    ProjectOnboardingWizard,
  ],
  templateUrl: './project-list.html',
  host: { class: 'block flex-1 overflow-y-auto bg-background' },
  viewProviders: [provideIcons({ lucideCalendarClock, lucideChevronRight, lucideFolder, lucideFolderOpen, lucidePlus, lucideSearch })],
})
export class ProjectList implements OnInit {
  private projectsService = inject(ProjectsService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private onboardingState = inject(OnboardingStateService);

  projects = signal<Project[]>([]);
  loading = signal(true);
  showCreateWizard = signal(false);
  searchTerm = signal('');
  showPortForwardStep = computed(() => this.onboardingState.snapshotState().mode !== 'local');
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

    this.projectsService.getAll().subscribe({
      next: (projects) => {
        this.projects.set(projects);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
      },
    });
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
    this.projects.update(list => list.some(entry => entry.id === project.id) ? list : [...list, project]);
    this.showCreateWizard.set(false);
    void this.router.navigate(['/projects', project.id]);
  }

  navigateToProject(id: number) {
    this.router.navigate(['/projects', id]);
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
