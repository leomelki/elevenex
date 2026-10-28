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
} from "../../ui";
import { ListPresence } from "../../ui/motion/list-presence";
import {
  matchesSessionFilter,
  type SessionStatus,
  type SubTask,
  type TaskSession,
} from "../task.models";
import { SessionRowComponent } from "./session-row.component";
import { TaskSignalComponent } from "./task-signal.component";
import { SubtaskGlyphComponent } from "./subtask-glyph.component";

interface SubtaskSessionRow {
  readonly key: string;
  readonly session: TaskSession;
}

/** One sub-task owns its folds; the task owns ancestry, hover and selection paths. */
@Component({
  selector: "ex-subtask-row",
  imports: [
    TaskSignalComponent,
    FlipDirective,
    FoldComponent,
    IconButtonComponent,
    SessionRowComponent,
    SubtaskGlyphComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./subtask-row.component.html",
  styleUrl: "./subtask-row.component.css",
  host: { "[class.lit]": "lit()", "[attr.data-subtask-id]": "subtask().id" },
})
export class SubtaskRowComponent implements OnChanges {
  readonly subtask = input.required<SubTask>();
  readonly depth = input(1);
  readonly path = input<readonly string[]>([]);
  readonly lit = input(false);
  readonly tip = input(false);
  readonly allowArchive = input(false);
  readonly archiveRequested = output<TaskSession>();
  readonly selected = input<string | null>(null);
  readonly reveal = input<{ readonly sessionId: string } | null>(null);
  readonly filter = input<SessionStatus | null>(null);
  readonly allowAdd = input(true);
  readonly selectSession = output<string>();
  readonly addSession = output<string>();
  readonly pathHover = output<string | null>();
  protected readonly open = signal(true);
  protected readonly sessions = computed(() => this.subtask().sessions ?? []);
  protected readonly working = computed(() =>
    this.sessions().filter((session) =>
      matchesSessionFilter(session.status, this.filter()),
    ),
  );
  protected readonly attention = computed(
    () =>
      this.sessions().filter(
        (session) =>
          session.status === "attention" || session.status === "failed",
      ).length,
  );
  protected readonly running = computed(
    () =>
      this.sessions().filter((session) => session.status === "running").length,
  );
  protected readonly tipText = computed(() => {
    const path = this.path().length > 1 ? this.path().slice(1) : this.path();
    return path
      .map((title, index) =>
        index < path.length - 1 && title.length > 12
          ? `${title.slice(0, 11).trim()}…`
          : title,
      )
      .join(" › ");
  });
  protected readonly label = computed(
    () =>
      this.subtask().title +
      this.path()
        .map((parent) => `, in ${parent}`)
        .join(""),
  );
  protected readonly tooltipId = `subtask-path-${crypto.randomUUID()}`;
  private readonly root =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly sessionRows = computed<readonly SubtaskSessionRow[]>(
    () => this.working().map((session) => ({
      key: `session:${session.id}`,
      session,
    })),
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
  ngOnChanges(changes: SimpleChanges): void {
    const sessionId =
      changes["reveal"] && this.reveal()
        ? this.reveal()?.sessionId
        : changes["selected"]
          ? this.selected()
          : null;
    if (
      sessionId &&
      this.sessions().some((session) => session.id === sessionId)
    )
      this.open.set(true);
  }
  protected blur(event: FocusEvent): void {
    if (
      !(event.relatedTarget instanceof Node) ||
      !this.root.contains(event.relatedTarget)
    )
      this.pathHover.emit(null);
  }
}
