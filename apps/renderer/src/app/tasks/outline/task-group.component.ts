import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnChanges,
  SimpleChanges,
  computed,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import {
  FlipDirective,
  FoldComponent,
  IconButtonComponent,
  IconComponent,
  TickerComponent,
} from "../../ui";
import {
  matchesSessionFilter,
  type SessionStatus,
  type TaskOutline,
  type TaskSession,
  type SubTask,
} from "../task.models";
import { ListPresence } from "../../ui/motion/list-presence";
import { ProjectMarkComponent } from "../projects/project-mark.component";
import { LinkChipComponent } from "../lifecycle/link-chip.component";
import { RepoTagComponent } from "../lifecycle/repo-tag.component";
import { SessionRowComponent } from "./session-row.component";
import { SubtaskRowComponent } from "./subtask-row.component";
import { SubtaskGlyphComponent } from "./subtask-glyph.component";
import { TaskSignalComponent } from "./task-signal.component";
import { subtaskLocations } from "./subtask-order";

type SessionOutlineRow =
  | {
      readonly kind: "session";
      readonly key: string;
      readonly session: TaskSession;
      readonly visible: boolean;
    }
  | {
      readonly kind: "subtask";
      readonly key: string;
      readonly subtask: SubTask;
      readonly depth: number;
      readonly path: readonly string[];
      readonly visible: boolean;
    }
  | {
      readonly kind: "more";
      readonly key: string;
      readonly count: number;
      readonly visible: boolean;
    }
  | {
      readonly kind: "merged";
      readonly key: string;
      readonly subtask: SubTask;
      readonly visible: boolean;
    }
  | {
      readonly kind: "finished";
      readonly key: string;
      readonly visible: boolean;
      readonly count: number;
      readonly merged: number;
    };

@Component({
  selector: "ex-task-group",
  imports: [
    TaskSignalComponent,
    TickerComponent,
    FlipDirective,
    FoldComponent,
    IconButtonComponent,
    IconComponent,
    ProjectMarkComponent,
    LinkChipComponent,
    RepoTagComponent,
    SessionRowComponent,
    SubtaskRowComponent,
    SubtaskGlyphComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./task-group.component.html",
  styleUrl: "./task-group.component.css",
})
export class TaskGroupComponent implements OnChanges {
  readonly task = input.required<TaskOutline>();
  readonly selected = input<string | null>(null);
  readonly filter = input<SessionStatus | null>(null);
  readonly showProject = input(true);
  readonly showLink = input(false);
  readonly allowAdd = input(true);
  readonly allowAddSubtask = input(true);
  readonly selectSession = output<string>();
  readonly addSession = output<string>();
  readonly addSubtaskSession = output<string>();
  protected readonly collapsedValue = signal<boolean | null>(null);
  protected readonly finishedValue = signal(false);
  protected readonly moreSubtasks = signal(false);
  private readonly hoveredSubtask = signal<string | null>(null);
  protected readonly tipSubtask = signal<string | null>(null);
  private tipTimer: ReturnType<typeof setTimeout> | undefined;
  protected readonly locations = computed(() =>
    subtaskLocations(this.task().subtasks ?? []),
  );
  private readonly filteredLocations = computed(() =>
    this.locations().filter(
      (location) =>
        !this.filter() ||
        location.subtask.sessions?.some((session) =>
          matchesSessionFilter(session.status, this.filter()),
        ),
    ),
  );
  private readonly shownLocations = computed(() => {
    const locations = this.filteredLocations();
    if (locations.length <= 4 || this.moreSubtasks()) return locations;
    return locations.filter(
      (location, index) =>
        index < 3 ||
        location.subtask.sessions?.some(
          (session) => session.id === this.selected(),
        ),
    );
  });
  private readonly hiddenSubtasks = computed(
    () => this.filteredLocations().length - this.shownLocations().length,
  );
  protected readonly litSubtasks = computed(() => {
    const locations = this.locations();
    const at =
      locations.find(
        (location) => location.subtask.id === this.hoveredSubtask(),
      ) ??
      locations.find((location) =>
        location.subtask.sessions?.some(
          (session) => session.id === this.selected(),
        ),
      );
    return new Set(
      at ? [...at.parents.map((parent) => parent.id), at.subtask.id] : [],
    );
  });
  protected readonly merged = computed(() =>
    this.filter()
      ? []
      : (this.task().subtasks ?? []).filter((subtask) => subtask.merged),
  );
  protected readonly everyone = computed(() =>
    this.task().sessions.concat(
      (this.task().subtasks ?? [])
        .filter((subtask) => !subtask.merged)
        .flatMap((subtask) => subtask.sessions ?? []),
    ),
  );
  protected readonly collapsed = computed(() =>
    this.filter()
      ? false
      : (this.collapsedValue() ??
        this.task().collapsed ??
        ["waiting", "planned", "closed"].includes(
          this.task().stage ?? "active",
        )),
  );
  protected readonly working = computed(() =>
    this.task().sessions.filter(
      (session) =>
        (session.status !== "done" || this.filter() === "done") &&
        matchesSessionFilter(session.status, this.filter()),
    ),
  );
  protected readonly finished = computed(() =>
    this.filter()
      ? []
      : this.task().sessions.filter((session) => session.status === "done"),
  );
  protected readonly finishedOpen = computed(
    () =>
      this.finishedValue() ||
      this.finished().some((session) => session.id === this.selected()),
  );
  protected readonly attention = computed(
    () =>
      this.everyone().filter(
        (session) =>
          session.status === "attention" || session.status === "failed",
      ).length,
  );
  protected readonly running = computed(
    () =>
      this.everyone().filter((session) => session.status === "running").length,
  );
  protected readonly leadLink = computed(
    () =>
      this.task().links?.find((link) => link.kind === "pr") ??
      this.task().links?.[0],
  );
  private foldTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly root =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly sessionRows = computed<readonly SessionOutlineRow[]>(
    () => [
      ...this.working().map((session) => ({
        kind: "session" as const,
        key: `session:${session.id}`,
        session,
        visible: true,
      })),
      ...this.shownLocations().map((location) => ({
        kind: "subtask" as const,
        key: `subtask:${location.subtask.id}`,
        subtask: location.subtask,
        depth: location.parents.length + 1,
        path: [
          this.task().title,
          ...location.parents.map((parent) => parent.title),
        ],
        visible: true,
      })),
      {
        kind: "more",
        key: "summary:more",
        count: this.hiddenSubtasks(),
        visible: this.hiddenSubtasks() > 0,
      },
      {
        kind: "finished",
        key: "summary:finished",
        count: this.finished().length,
        merged: this.merged().length,
        visible: this.finished().length + this.merged().length > 0,
      },
      ...this.finished().map((session) => ({
        kind: "session" as const,
        key: `session:${session.id}`,
        session,
        visible: this.finishedOpen(),
      })),
      ...this.merged().map((subtask) => ({
        kind: "merged" as const,
        key: `merged:${subtask.id}`,
        subtask,
        visible: this.finishedOpen(),
      })),
    ],
  );
  protected readonly presence = new ListPresence(
    this.sessionRows,
    (row) => row.key,
    this.root,
    inject(DestroyRef),
  );
  protected readonly motionOrder = computed(() =>
    this.presence
      .rows()
      .map((row) => row.key)
      .join("\n"),
  );
  constructor() {
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.foldTimer);
      clearTimeout(this.tipTimer);
    });
  }
  ngOnChanges(changes: SimpleChanges): void {
    const previousTask: TaskOutline | undefined = changes["task"]?.previousValue;
    const stage = this.task().stage ?? "active";
    if (previousTask && (previousTask.stage ?? "active") !== stage) {
      clearTimeout(this.foldTimer);
      // Carry the painted fold state through the move, including stage defaults.
      // Only an expanded task needs the glide-then-collapse sequence.
      const wasCollapsed =
        this.collapsedValue() ??
        previousTask.collapsed ??
        ["waiting", "planned", "closed"].includes(previousTask.stage ?? "active");
      this.collapsedValue.set(wasCollapsed);
      if (!wasCollapsed && (stage === "waiting" || stage === "planned")) {
        const duration = matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : parseFloat(
              getComputedStyle(this.root).getPropertyValue("--dur-glide"),
            ) || 0;
        if (duration)
          this.foldTimer = setTimeout(
            () => this.collapsedValue.set(true),
            duration,
          );
        else this.collapsedValue.set(true);
      }
    }
  }
  protected hoverSubtask(id: string | null): void {
    clearTimeout(this.tipTimer);
    this.hoveredSubtask.set(id);
    this.tipSubtask.set(null);
    if (id) this.tipTimer = setTimeout(() => this.tipSubtask.set(id), 500);
  }
  protected toggle(): void {
    this.collapsedValue.set(!this.collapsed());
  }
}
