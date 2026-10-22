import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { CdkMenuModule } from '@angular/cdk/menu';
import { IconComponent } from '../../ui';
import { TASK_STAGE_LABELS, type TaskStage } from '../task.models';
import { StageGlyphComponent } from './stage-glyph.component';
@Component({
  selector: 'ex-task-stage',
  imports: [CdkMenuModule, IconComponent, StageGlyphComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './task-stage.component.html',
  styleUrls: ['../tasks-menu.css', './task-stage.component.css'],
})
export class TaskStageComponent {
  readonly stage = input<TaskStage>('planned');
  readonly stageChange = output<TaskStage>();
  protected readonly labels = TASK_STAGE_LABELS;
  protected readonly stages: readonly TaskStage[] = [
    'planned',
    'active',
    'waiting',
    'closed',
  ];
}
