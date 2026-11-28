import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { IconComponent, StatusGlyphComponent } from '../../ui';
import type { TaskContext } from '../task.models';
import { ProjectMarkComponent } from '../projects/project-mark.component';
import { BranchChipComponent } from '../branches/branch-chip.component';
@Component({
  selector: 'ex-task-line',
  imports: [
    IconComponent,
    StatusGlyphComponent,
    ProjectMarkComponent,
    BranchChipComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './task-line.component.html',
  styleUrl: './task-line.component.css',
})
export class TaskLineComponent {
  readonly task = input.required<TaskContext>();
  readonly branchCopied = input(false);
  readonly renameRequested = output<void>();
  readonly branchRename = output<string>();
  readonly branchCopy = output<string>();
}
