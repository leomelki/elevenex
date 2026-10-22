import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
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
import { ListPresence } from '../../ui/motion/list-presence';
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
    }
  | { readonly kind: 'empty'; readonly key: string; readonly visible: boolean }
  | { readonly kind: 'closed'; readonly key: string; readonly visible: boolean; readonly count: number };
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
    const empty = !rows.some(row => row.kind === 'task' && row.visible);
    const closed = this.tasks().filter(task => task.stage === 'closed').length;
    rows.push({ kind: 'empty', key: 'empty', visible: empty });
    rows.push({ kind: 'closed', key: 'closed', visible: closed > 0, count: closed });
    return rows;
  });
  protected readonly presence = new ListPresence(this.rows, row => row.key,
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement, inject(DestroyRef));
  protected readonly motionOrder = computed(() => this.presence.rows().map(row => row.key).join('\n'));
}
