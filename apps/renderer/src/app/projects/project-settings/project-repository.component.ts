import { ChangeDetectionStrategy, Component, computed, input, linkedSignal, output } from '@angular/core';
import { ButtonComponent } from '../../ui/button/button.component';
import { IconComponent } from '../../ui/icon/icon.component';
import { FoldComponent } from '../../ui/motion/fold.component';
import { SetChoiceComponent, SetValueComponent } from '../../ui/sheet/settings-controls.component';
import type { ProjectRepository, RepositorySettingsPatch } from './project-settings.models';
import { RepoTagComponent } from '../../tasks/lifecycle/repo-tag.component';

@Component({ selector: 'ex-project-repository', imports: [ButtonComponent, IconComponent, FoldComponent, SetChoiceComponent, SetValueComponent, RepoTagComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './project-repository.component.html', styleUrl: './project-repository.component.css' })
export class ProjectRepositoryComponent {
  readonly repo = input.required<ProjectRepository>();
  readonly open = input(false);
  readonly toggled = output<void>();
  readonly changed = output<RepositorySettingsPatch>();
  readonly removeRequested = output<void>();
  protected readonly draftTag = linkedSignal(() => this.repo().short);
  protected readonly shownRepo = computed(() => ({ ...this.repo(), short: this.draftTag() }));
  protected readonly branches = computed(() => Array.from(new Set([this.repo().base ?? 'main', ...(this.repo().branches ?? [])])).slice(0, 100).map(id => ({ id, label: id })));
  protected tagInput(value: string): void { this.draftTag.set(value); }
}
