import { ChangeDetectionStrategy, Component, computed, ElementRef, signal, viewChild } from '@angular/core';
import { ButtonComponent } from '../src/app/ui';
import {
  StatusSummaryComponent,
  TaskListComponent,
  TASK_STAGE_LABELS,
  type SessionStatus,
  type SummaryStatus,
  type TaskOutline,
  type TaskSession,
  type TaskStage,
} from '../src/app/tasks';

type Position = 'start' | 'middle' | 'end';

/** Deterministic, isolated input data for exercising the real sidebar components. */
@Component({
  selector: 'ex-sidebar-motion-demo',
  imports: [ButtonComponent, StatusSummaryComponent, TaskListComponent],
  templateUrl: './sidebar-motion-demo.component.html',
  styleUrl: './sidebar-motion-demo.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SidebarMotionDemoComponent {
  readonly tasks = signal<readonly TaskOutline[]>(this.initialTasks());
  readonly selected = signal<string | null>('task-4-session-1');
  readonly filter = signal<SummaryStatus | null>(null);
  readonly targetId = signal('task-4');
  readonly lastAction = signal('Ten original tasks, with the fourth session selected.');
  readonly stages: readonly TaskStage[] = ['active', 'waiting', 'planned', 'closed'];
  readonly stageLabels = TASK_STAGE_LABELS;
  readonly currentTask = computed(() => this.tasks().find(task => task.id === this.targetId()) ?? this.tasks()[0]);
  readonly sessionCount = computed(() => this.tasks().reduce((total, task) => total + task.sessions.length, 0));
  readonly taskOrder = computed(() => this.tasks().map(task => task.id).join(' → '));
  readonly counts = computed(() => {
    const counts = { attention: 0, running: 0, review: 0, done: 0 };
    for (const task of this.tasks()) {
      for (const session of task.sessions) {
        if (session.status === 'failed') counts.attention += 1;
        else if (session.status !== 'queued') counts[session.status] += 1;
      }
    }
    return counts;
  });
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private nextTask = 11;
  private nextSession = 1;

  reset(): void {
    this.tasks.set(this.initialTasks());
    this.selected.set('task-4-session-1');
    this.targetId.set('task-4');
    this.filter.set(null);
    this.lastAction.set('Restored the ten original task identities.');
  }

  add(position: Position = 'end', count = 1): void {
    const added: TaskOutline[] = Array.from({ length: Math.min(100, Math.max(1, count)) }, () => {
      const number = this.nextTask++;
      const id = `task-${number}`;
      return {
        id,
        title: `${String(number).padStart(2, '0')} · Added task`,
        stage: 'active',
        sessions: [{ id: `${id}-session-1`, title: 'Explore the new task', status: 'queued' }],
      };
    });
    this.tasks.update(tasks => {
      const index = position === 'start' ? 0 : position === 'middle' ? Math.floor(tasks.length / 2) : tasks.length;
      return [...tasks.slice(0, index), ...added, ...tasks.slice(index)];
    });
    this.lastAction.set(`Added ${added.length} at the ${position}.`);
  }

  remove(position: Position): void {
    const tasks = this.tasks();
    const index = position === 'start' ? 0 : position === 'middle' ? Math.floor(tasks.length / 2) : tasks.length - 1;
    const task = tasks[index];
    if (!task) return;
    this.tasks.set(tasks.filter(item => item.id !== task.id));
    this.clearMissingSelection();
    this.lastAction.set(`Removed ${task.id}.`);
  }

  keepOriginal(indices: readonly number[]): void {
    const keep = new Set(indices.map(index => `task-${index}`));
    this.tasks.update(tasks => tasks.filter(task => keep.has(task.id)));
    this.clearMissingSelection();
    this.lastAction.set(`Kept original ${[...keep].join(' and ')}; every other task was removed.`);
  }

  clear(): void {
    this.tasks.set([]);
    this.selected.set(null);
    this.lastAction.set('Removed every task.');
  }

  reverse(): void {
    this.tasks.update(tasks => [...tasks].reverse());
    this.lastAction.set('Reversed task order without changing identities.');
  }

  chooseTask(id: string): void {
    this.targetId.set(id);
    this.selected.set(this.currentTask()?.sessions[0]?.id ?? null);
  }

  selectSession(selection: { readonly taskId: string; readonly sessionId: string }): void {
    this.targetId.set(selection.taskId);
    this.selected.set(selection.sessionId);
    this.lastAction.set(`Selected ${selection.sessionId}.`);
  }

  selectSessionId(id: string): void {
    if (this.currentTask()?.sessions.some(session => session.id === id)) this.selected.set(id);
  }

  move(stage: TaskStage, all = false): void {
    const id = this.currentTask()?.id;
    this.tasks.update(tasks => tasks.map(task => all || task.id === id ? { ...task, stage } : task));
    this.lastAction.set(`Moved ${all ? 'every task' : id ?? 'no task'} to ${TASK_STAGE_LABELS[stage]}.`);
  }

  addSession(taskId = this.currentTask()?.id): void {
    if (!taskId) return;
    const session: TaskSession = {
      id: `${taskId}-added-session-${this.nextSession++}`,
      title: 'Explore another approach',
      status: 'queued',
      kind: 'fork',
    };
    this.tasks.update(tasks => tasks.map(task => task.id === taskId ? { ...task, sessions: [...task.sessions, session] } : task));
    this.lastAction.set(`Added ${session.id}.`);
  }

  removeSession(): void {
    const task = this.currentTask();
    const session = task?.sessions.find(item => item.id === this.selected()) ?? task?.sessions.at(-1);
    if (!task || !session) return;
    this.tasks.update(tasks => tasks.map(item => item.id === task.id ? { ...item, sessions: item.sessions.filter(row => row.id !== session.id) } : item));
    this.clearMissingSelection();
    this.lastAction.set(`Removed ${session.id}.`);
  }

  finishSession(): void {
    const task = this.currentTask();
    const session = task?.sessions.find(item => item.id === this.selected() && item.status !== 'done') ?? task?.sessions.find(item => item.status !== 'done');
    if (!task || !session) return;
    this.tasks.update(tasks => tasks.map(item => item.id === task.id ? { ...item, sessions: item.sessions.map(row => row.id === session.id ? { ...row, status: 'done' } : row) } : item));
    this.lastAction.set(`Finished ${session.id}.`);
  }

  scroll(position: Position): void {
    const element = this.scroller()?.nativeElement;
    if (!element) return;
    const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = position === 'start' ? 0 : position === 'middle' ? bottom / 2 : bottom;
  }

  private clearMissingSelection(): void {
    if (!this.tasks().some(task => task.sessions.some(session => session.id === this.selected()))) this.selected.set(null);
  }

  private initialTasks(): readonly TaskOutline[] {
    const titles = ['Inspect repository', 'Review incoming changes', 'Map agent events', 'Keep checkouts ready', 'Improve branch search', 'Check shutdown cleanup', 'Restore task sessions', 'Polish keyboard focus', 'Handle reconnects', 'Review final changes'];
    const statuses: readonly SessionStatus[] = ['running', 'attention', 'review', 'queued'];
    return titles.map((title, index) => {
      const number = index + 1;
      const id = `task-${number}`;
      const sessionCount = number === 4 ? 3 : number === 7 ? 2 : 1;
      return {
        id,
        title: `${String(number).padStart(2, '0')} · ${title}`,
        stage: 'active',
        sessions: Array.from({ length: sessionCount }, (_, session) => ({
          id: `${id}-session-${session + 1}`,
          title: session ? `Check approach ${session + 1}` : 'Explore the implementation',
          status: statuses[(index + session) % statuses.length] ?? 'queued',
        })),
      };
    });
  }
}
