import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { ButtonComponent, IconButtonComponent, IconComponent } from '../../ui';
import type {
  GitAction,
  GitState,
  ProjectMark,
  Repo,
  TaskParentContext,
  TaskLink,
  TaskStage,
} from '../task.models';
import { ProjectMarkComponent } from '../projects/project-mark.component';
import { RepoTagComponent } from './repo-tag.component';
import { BranchChipComponent } from '../branches/branch-chip.component';
import { GitBarComponent } from '../navigation/git-bar.component';
import { TaskStageComponent } from './task-stage.component';
import { LinkChipComponent } from './link-chip.component';
@Component({
  selector: 'ex-task-header',
  imports: [
    ButtonComponent,
    IconButtonComponent,
    IconComponent,
    ProjectMarkComponent,
    BranchChipComponent,
    GitBarComponent,
    TaskStageComponent,
    LinkChipComponent,
    RepoTagComponent,
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
  readonly stage = input<TaskStage>('active');
  readonly branch = input<string>();
  readonly links = input<readonly TaskLink[]>([]);
  readonly meta = input<string>();
  readonly project = input<ProjectMark>();
  readonly git = input<GitState>();
  readonly closeSuggested = input(false);
  readonly panelOpen = input(false);
  readonly branchCopied = input(false);
  readonly stageChange = output<TaskStage>();
  readonly closeRequested = output<void>();
  readonly panelToggle = output<void>();
  readonly branchRename = output<string>();
  readonly branchCopy = output<string>();
  readonly linkRequested = output<void>();
  readonly linkActivated = output<TaskLink>();
  readonly gitAction = output<GitAction>();
  readonly gitJobSessionRequested = output<string>();
  readonly gitJobCancelled = output<string>();
  readonly changesRequested = output<void>();
}
