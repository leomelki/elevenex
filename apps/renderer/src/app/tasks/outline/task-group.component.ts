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
  model,
  output,
  signal,
} from "@angular/core";
import {
  FlipDirective,
  FoldComponent,
  IconButtonComponent,
  IconComponent,
  TickerComponent,
  TooltipDirective,
} from "../../ui";
import {
  matchesSessionFilter,
  unloadedChildCounts,
  type SessionStatus,
  type TaskOutline,
  type TaskSession,
  type TaskSessionDisclosure,
  type TaskSessionHistoryRequest,
  type SubTask,
} from "../task.models";
import { ListPresence } from "../../ui/motion/list-presence";
import { ProjectMarkComponent } from "../projects/project-mark.component";
import { LinkChipComponent } from "../lifecycle/link-chip.component";
import { RepoTagComponent } from "../lifecycle/repo-tag.component";
import { WorkingSessionsComponent } from "./working-sessions.component";
import { SubtaskRowComponent } from "./subtask-row.component";
import { SubtaskGlyphComponent } from "./subtask-glyph.component";
import { TaskSignalComponent } from "./task-signal.component";
import { subtaskLocations } from "./subtask-order";

import { SessionNestingDragDirective } from './session-nesting-drag.directive';
import { ArchivedSessionsComponent } from "./archived-sessions.component";

type SessionOutlineRow =
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
  | { readonly kind: "empty"; readonly key: string; readonly visible: boolean }
  | {
      readonly kind: "merged-summary";
      readonly key: string;
      readonly visible: boolean;
      readonly count: number;
    };

@Component({
  selector: "ex-task-group",
  imports: [
    SessionNestingDragDirective,
    ArchivedSessionsComponent,
    TaskSignalComponent,
    TickerComponent,
    TooltipDirective,
    FlipDirective,
    FoldComponent,
    IconButtonComponent,
    IconComponent,
    ProjectMarkComponent,
    LinkChipComponent,
    RepoTagComponent,
    WorkingSessionsComponent,
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
  readonly reveal = input<{ readonly sessionId: string } | null>(null);
  readonly filter = input<SessionStatus | null>(null);
  readonly showProject = input(true);
  readonly showLink = input(false);
  readonly cap = input(5);
  readonly capStep = input(5);
  readonly allowArchive = input(false);
  readonly archiveRequested = output<TaskSession>();
  readonly deleteRequested = output<TaskSession>();
  readonly restoreRequested = output<TaskSession>();
  readonly archivedSessionsRequested = output<'latest' | 'earlier'>();
  readonly archiveDisabled = input(false);
  readonly allowNesting = input(false);
  readonly moveSessionRequested = output<{ readonly taskId: string; readonly sessionId: string; readonly parentSessionId: string | null }>();
  readonly sessionChildrenRequested = output<{ readonly taskId: string; readonly sessionId: string; readonly earlier?: boolean }>();
  readonly allowAdd = input(true);
  readonly sessionDisclosure = model<TaskSessionDisclosure | null>(null);
  readonly allowAddSubtask = input(true);
  readonly selectSession = output<string>();
  readonly addSession = output<string>();
  readonly moreSessionsRequested = output<TaskSessionHistoryRequest>();
  readonly emptyTaskRequested = output<string>();
  readonly addSubtaskSession = output<string>();
  protected readonly collapsedValue = signal<boolean | null>(null);
  protected readonly mergedOpen = signal(false);
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
  protected readonly current = computed(() => this.everyone().some(session => session.id === this.selected()) || !!this.task().archive?.sessions.some(session => session.id === this.selected()));
  protected readonly collapsed = computed(() =>
    this.filter()
      ? false
      : (this.collapsedValue() ?? this.task().collapsed ?? false),
  );
  protected readonly working = computed(() => {
    const rows = this.task().sessions, filter = this.filter();
    if (!filter) return rows;
    const parents = new Set(rows.flatMap(child => child.parentId && matchesSessionFilter(child.status, filter) ? [child.parentId] : []));
    return rows.filter(row => parents.has(row.id) || matchesSessionFilter(row.status, filter) ||
      (!!row.childSummary && matchesSessionFilter(row.childSummary.status, filter)));
  });
  private readonly hiddenChildren = computed(() => unloadedChildCounts(this.everyone()));
  protected readonly attention = computed(
    () =>
      this.everyone().filter(
        (session) =>
          session.status === "attention" || session.status === "failed",
      ).length + this.everyone().reduce((total, row) => total +
        (row.childSummary && matchesSessionFilter(row.childSummary.status, 'attention') ? this.hiddenChildren().get(row.id) ?? 0 : 0), 0),
  );
  protected readonly running = computed(
    () =>
      this.everyone().filter((session) => session.status === "running").length +
        this.everyone().reduce((total, row) => total + (row.childSummary?.status === 'running' ? this.hiddenChildren().get(row.id) ?? 0 : 0), 0),
  );
  protected readonly leadLink = computed(
    () =>
      this.task().links?.find((link) => link.kind === "pr") ??
      this.task().links?.[0],
  );
  private readonly showEmptySessionAction = computed(() =>
    this.task().sessions.length === 0 && this.locations().length === 0 &&
    !this.task().moreSessions && !this.filter() && this.allowAdd() &&
    this.task().canAddSession !== false,
  );
  private readonly root =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly sessionRows = computed<readonly SessionOutlineRow[]>(
    () => [
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
        kind: "merged-summary",
        key: "summary:merged",
        count: this.merged().length,
        visible: this.merged().length > 0,
      },
      ...this.merged().map((subtask) => ({
        kind: "merged" as const,
        key: `merged:${subtask.id}`,
        subtask,
        visible: this.mergedOpen(),
      })),
      // A label introduces the action before the first session. Selection must
      // never insert or remove controls in a populated task's outline.
      ...(this.showEmptySessionAction() ? [{
        kind: "empty" as const,
        key: "empty-session",
        visible: true,
      }] : []),
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
      clearTimeout(this.tipTimer);
    });
  }
  ngOnChanges(changes: SimpleChanges): void {
    // A shortcut selection must reveal its canonical row, even in a folded task.
    const sessionId =
      changes["reveal"] && this.reveal()
        ? this.reveal()?.sessionId
        : changes["selected"]
          ? this.selected()
          : null;
    if (
      sessionId &&
      (this.everyone().some((session) => session.id === sessionId) || this.task().archive?.sessions.some(session => session.id === sessionId))
    )
      this.collapsedValue.set(false);
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
