import { ChangeDetectionStrategy, Component, computed, input, linkedSignal, output } from '@angular/core';
import { ButtonComponent } from '../../ui/button/button.component';
import { IconComponent } from '../../ui/icon/icon.component';
import { FoldComponent } from '../../ui/motion/fold.component';
import { SetValueComponent } from '../../ui/sheet/settings-controls.component';
import { RepositoryBranchPickerComponent } from './repository-branch-picker.component';
import type { ProjectRepository, RepositorySettingsPatch } from './project-settings.models';
import { RepoTagComponent } from '../../tasks/lifecycle/repo-tag.component';

@Component({ selector: 'ex-project-repository', imports: [ButtonComponent, IconComponent, FoldComponent, RepositoryBranchPickerComponent, SetValueComponent, RepoTagComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './project-repository.component.html', styleUrl: './project-repository.component.css' })
export class ProjectRepositoryComponent {
  readonly repo = input.required<ProjectRepository>();
  readonly open = input(false);
  readonly active = input(true);
  readonly toggled = output<void>();
  readonly changed = output<RepositorySettingsPatch>();
  readonly removeRequested = output<void>();
  protected readonly draftTag = linkedSignal(() => this.repo().short);
  protected readonly shownRepo = computed(() => ({ ...this.repo(), short: this.draftTag() }));
  protected tagInput(value: string): void { this.draftTag.set(value); }
}
