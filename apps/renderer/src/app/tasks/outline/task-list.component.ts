import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  input,
  linkedSignal,
  model,
  output,
  signal,
} from "@angular/core";
import { FlipDirective, FoldComponent, TickerComponent } from "../../ui";
import {
  matchesSessionFilter,
  type SessionStatus,
  type TaskOutline,
  type TaskSession,
  type TaskSessionDisclosure,
} from "../task.models";
import { TaskGroupComponent } from "./task-group.component";
import { SessionRowComponent } from "./session-row.component";
import { ListPresence } from "../../ui/motion/list-presence";
type OutlineRow =
  | {
      readonly kind: "heading";
      readonly key: string;
      readonly label: "Needs you" | "Tasks";
      readonly count: number;
      readonly visible: boolean;
    }
  | {
      readonly kind: "attention";
      readonly key: string;
      readonly taskId: string;
      readonly session: TaskSession;
      readonly context: string;
      readonly visible: boolean;
    }
  | {
      readonly kind: "more";
      readonly key: string;
      readonly count: number;
      readonly visible: boolean;
    }
  | {
      readonly kind: "task";
      readonly key: string;
      readonly task: TaskOutline;
      readonly visible: boolean;
    }
  | { readonly kind: "empty"; readonly key: string; readonly visible: boolean }
  | {
      readonly kind: "closed";
      readonly key: string;
      readonly visible: boolean;
      readonly count: number;
    };
type AttentionRow = Extract<OutlineRow, { kind: "attention" }>;
@Component({
  selector: "ex-task-list",
  imports: [
    FlipDirective,
    FoldComponent,
    TickerComponent,
    TaskGroupComponent,
    SessionRowComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./task-list.component.html",
  styleUrl: "./task-list.component.css",
})
export class TaskListComponent {
  readonly sessionCap = input(5);
  /** Bind in an owner that outlives project views; at most 200 task disclosures. */
  readonly sessionDisclosures = model<ReadonlyMap<string, TaskSessionDisclosure>>(new Map());
  protected setSessionDisclosure(taskId: string, disclosure: TaskSessionDisclosure | null): void {
    this.sessionDisclosures.update(previous => {
      const next = new Map(previous);
      next.delete(taskId);
      if (disclosure) next.set(taskId, disclosure);
      while (next.size > 200) next.delete(next.keys().next().value!);
      return next;
    });
  }
  readonly tasks = input<readonly TaskOutline[]>([]);
  readonly allowArchive = input(false);
  readonly restoreRequested = output<{ readonly taskId: string; readonly session: TaskSession }>();
  readonly archivedSessionsRequested = output<{ readonly taskId: string; readonly page: 'latest' | 'earlier' }>();
  readonly archiveRequested = output<{ readonly taskId: string; readonly session: TaskSession }>();
  readonly selected = input<string | null>(null);
  readonly filter = input<SessionStatus | null>(null);
  readonly showProjects = input(true);
  readonly disabled = input(false);
  readonly selectSession = output<{
    readonly taskId: string;
    readonly sessionId: string;
  }>();
  readonly addSession = output<string>();
  readonly moreSessionsRequested = output<string>();
  readonly emptyTaskRequested = output<string>();
  readonly addSubtaskSession = output<{
    readonly taskId: string;
    readonly subtaskId: string;
  }>();
  readonly closedRequested = output<void>();
  protected readonly attentionExpanded = signal(false);
  protected readonly revealRequest = signal<{
    readonly sessionId: string;
  } | null>(null);
  /** Keep requests in arrival order even if the owner reorders its task window. */
  private readonly attention = linkedSignal<
    readonly AttentionRow[],
    readonly AttentionRow[]
  >({
    source: () => {
      const rows: AttentionRow[] = [];
      for (const task of this.tasks()) {
        if (task.stage === "closed") continue;
        const context = [
          this.showProjects() ? task.project?.name : null,
          task.title,
        ]
          .filter(Boolean)
          .join(" · ");
        const visit = (session: TaskSession, sessionContext: string): void => {
          if (matchesSessionFilter(session.status, "attention"))
            rows.push({
              kind: "attention",
              key: `attention:${task.id}:${session.id}`,
              taskId: task.id,
              session,
              context: sessionContext,
              visible: true,
            });
        };
        for (const session of task.sessions) visit(session, context);
        for (const subtask of task.subtasks ?? []) {
          if (!subtask.merged)
            for (const session of subtask.sessions ?? [])
              visit(session, `${context} › ${subtask.title}`);
        }
      }
      return rows;
    },
    computation: (rows, previous) => {
      const remaining = new Map(rows.map((row) => [row.key, row]));
      const ordered: AttentionRow[] = [];
      for (const row of previous?.value ?? []) {
        const current = remaining.get(row.key);
        if (current) {
          ordered.push(current);
          remaining.delete(row.key);
        }
      }
      return [...ordered, ...remaining.values()];
    },
  });
  /** Attention shortcuts leave the canonical task order and local folds intact. */
  protected readonly rows = computed<readonly OutlineRow[]>(() => {
    const rows: OutlineRow[] = [];
    const tasks: OutlineRow[] = [];
    const filter = this.filter();
    const attention = filter
      ? []
      : this.attention().map((row, index) => ({
          ...row,
          visible: this.attentionExpanded() || index < 3,
        }));
    let visibleTasks = 0;
    let closed = 0;
    for (const task of this.tasks()) {
      if (task.stage === "closed") {
        closed++;
        continue;
      }
      const visible =
        !filter ||
        task.sessions.some((session) =>
          matchesSessionFilter(session.status, filter),
        ) ||
        (task.subtasks ?? []).some(
          (subtask) =>
            !subtask.merged &&
            subtask.sessions?.some((session) =>
              matchesSessionFilter(session.status, filter),
            ),
        );
      if (visible) visibleTasks++;
      tasks.push({ kind: "task", key: `task:${task.id}`, task, visible });
    }
    rows.push(
      {
        kind: "heading",
        key: "heading:attention",
        label: "Needs you",
        count: attention.length,
        visible: attention.length > 0,
      },
      ...attention,
      {
        kind: "more",
        key: "more:attention",
        count: Math.max(0, attention.length - 3),
        visible: attention.length > 3,
      },
      {
        kind: "heading",
        key: "heading:tasks",
        label: "Tasks",
        count: visibleTasks,
        visible: visibleTasks > 0,
      },
      ...tasks,
    );
    rows.push({ kind: "empty", key: "empty", visible: visibleTasks === 0 });
    rows.push({
      kind: "closed",
      key: "closed",
      visible: closed > 0,
      count: closed,
    });
    return rows;
  });
  protected readonly presence = new ListPresence(
    this.rows,
    (row) => row.key,
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement,
    inject(DestroyRef),
  );
  protected readonly motionOrder = computed(() =>
    this.presence
      .rows()
      .map((row) => row.key)
      .join("\n"),
  );
  protected openAttention(taskId: string, sessionId: string): void {
    // A fresh request also reveals an already-selected session after a manual fold.
    this.revealRequest.set({ sessionId });
    this.selectSession.emit({ taskId, sessionId });
  }
}
