import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft, lucideCheck, lucideGitBranch, lucideSettings } from '@ng-icons/lucide';

import { ZardButtonComponent } from '@/shared/components/button';
import { OptionSelectComponent } from '@/shared/components/option-select/option-select.component';
import { Repo } from '@/shared/models/repo.model';

@Component({
  selector: 'app-project-start',
  imports: [NgIcon, ZardButtonComponent, OptionSelectComponent],
  templateUrl: './project-start.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  viewProviders: [provideIcons({ lucideArrowLeft, lucideCheck, lucideGitBranch, lucideSettings })],
})
export class ProjectStartComponent {
  readonly projectName = input.required<string>();
  readonly repos = input.required<Repo[]>();
  readonly startTask = output<Repo>();
  readonly settings = output<void>();
  readonly back = output<void>();
  readonly selectedRepoId = signal('');
  readonly selectedRepo = computed(
    () => this.repos().find((repo) => String(repo.id) === this.selectedRepoId()) ?? this.repos()[0],
  );
  readonly repoOptions = computed(() =>
    this.repos().map((repo) => ({
      value: String(repo.id),
      label: repo.name,
      description: repo.path,
    })),
  );

  start() {
    const repo = this.selectedRepo();
    if (repo) this.startTask.emit(repo);
  }
}
