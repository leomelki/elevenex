import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { FlipDirective, FoldComponent } from '../../ui';
import {
  TASK_STAGE_LABELS,
  matchesSessionFilter,
  type SessionStatus,
  type TaskOutline,
  type TaskStage,
} from '../task.models';
import { TaskGroupComponent } from './task-group.component';
type OutlineRow =
  | {
      readonly kind: 'stage';
      readonly key: string;
      readonly stage: TaskStage;
      readonly count: number;
      readonly visible: boolean;
    }
  | {
      readonly kind: 'task';
      readonly key: string;
      readonly task: TaskOutline;
      readonly visible: boolean;
    };
@Component({
  selector: 'ex-task-list',
  imports: [FlipDirective, FoldComponent, TaskGroupComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './task-list.component.html',
  styleUrl: './task-list.component.css',
})
export class TaskListComponent {
  readonly tasks = input<readonly TaskOutline[]>([]);
  readonly selected = input<string | null>(null);
  readonly filter = input<SessionStatus | null>(null);
  readonly showProjects = input(true);
  readonly selectSession = output<{
    readonly taskId: string;
    readonly sessionId: string;
  }>();
  readonly addSession = output<string>();
  readonly closedRequested = output<void>();
  protected readonly labels = TASK_STAGE_LABELS;
  /** One keyed outline keeps each task's local fold state when its stage changes. */
  protected readonly rows = computed<readonly OutlineRow[]>(() => {
    const rows: OutlineRow[] = [];
    const stages: readonly TaskStage[] = ['active', 'waiting', 'planned'];
    for (const stage of stages) {
      const tasks = this.tasks().filter(
        (task) => (task.stage ?? 'active') === stage,
      );
      if (!tasks.length) continue;
      const visible = (task: TaskOutline): boolean =>
        !this.filter() ||
        task.sessions.some((session) =>
          matchesSessionFilter(session.status, this.filter()),
        );
      const count = tasks.filter(visible).length;
      rows.push({
        kind: 'stage',
        key: `stage:${stage}`,
        stage,
        count,
        visible: count > 0,
      });
      for (const task of tasks)
        rows.push({
          kind: 'task',
          key: `task:${task.id}`,
          task,
          visible: visible(task),
        });
    }
    return rows;
  });
  protected readonly hasVisible = computed(() =>
    this.rows().some((row) => row.kind === 'task' && row.visible),
  );
  protected readonly closedCount = computed(
    () => this.tasks().filter((task) => task.stage === 'closed').length,
  );
}
