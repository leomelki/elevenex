import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronRight, lucideFolderOpen } from '@ng-icons/lucide';

import { ZardButtonComponent } from '@/shared/components/button';
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
    ZardSkeletonComponent,
    ProjectOnboardingWizard,
  ],
  templateUrl: './project-list.html',
  host: { class: 'block flex-1 overflow-y-auto p-8' },
  viewProviders: [provideIcons({ lucideChevronRight, lucideFolderOpen })],
})
export class ProjectList implements OnInit {
  private projectsService = inject(ProjectsService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private onboardingState = inject(OnboardingStateService);

  projects = signal<Project[]>([]);
  loading = signal(true);
  showCreateWizard = signal(false);
  showPortForwardStep = computed(() => this.onboardingState.snapshotState().mode !== 'local');

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
}
