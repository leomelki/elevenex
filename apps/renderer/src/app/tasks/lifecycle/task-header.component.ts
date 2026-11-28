import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { CdkMenuTrigger } from '@angular/cdk/menu';
import { ButtonComponent, DropdownItemComponent, DropdownMenuComponent, IconButtonComponent, IconComponent, TooltipDirective } from '../../ui';
import type {
  GitAction,
  GitState,
  ProjectMark,
  Repo,
  TaskParentContext,
  TaskLink,
} from '../task.models';
import { ProjectMarkComponent } from '../projects/project-mark.component';
import { RepoTagComponent } from './repo-tag.component';
import { GitBarComponent } from '../navigation/git-bar.component';
import { LinkChipComponent } from './link-chip.component';
@Component({
  selector: 'ex-task-header',
  imports: [
    ButtonComponent,
    CdkMenuTrigger,
    DropdownItemComponent,
    DropdownMenuComponent,
    IconButtonComponent,
    IconComponent,
    ProjectMarkComponent,
    GitBarComponent,
    LinkChipComponent,
    RepoTagComponent,
    TooltipDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './task-header.component.html',
  styleUrl: './task-header.component.css',
})
export class TaskHeaderComponent {
  readonly title = input.required<string>();
  readonly repo = input<Repo | string>();
  readonly parent = input<TaskParentContext>();
  readonly parentRequested = output<TaskParentContext>();
  readonly branch = input<string>();
  readonly links = input<readonly TaskLink[]>([]);
  readonly meta = input<string>();
  readonly project = input<ProjectMark>();
  readonly git = input<GitState>();
  readonly closeSuggested = input(false);
  readonly panelOpen = input(false);
  readonly branchCopied = input(false);
  readonly disabled = input(false);
  readonly closed = input(false);
  readonly canKeepOpen = input(false);
  readonly canRenameBranch = input(true);
  readonly canLink = input(true);
  readonly gitAllowedActions = input<readonly GitAction[]>();
  readonly gitActionsDisabled = input(false);
  readonly gitQuietLabel = input('Up to date');
  readonly unreachable = input<string>();
  readonly closeRequested = output<void>();
  readonly keepOpenRequested = output<void>();
  readonly panelToggle = output<void>();
  readonly branchRename = output<string>();
  readonly branchCopy = output<string>();
  readonly linkRequested = output<void>();
  readonly linkActivated = output<TaskLink>();
  readonly gitAction = output<GitAction>();
  readonly gitJobSessionRequested = output<string>();
  readonly gitJobCancelled = output<string>();
  readonly changesRequested = output<void>();

  protected readonly showCloseAction = computed(() => !this.closed() && this.closeSuggested());
}
