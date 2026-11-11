import { A11yModule } from "@angular/cdk/a11y";
import { OverlayModule } from "@angular/cdk/overlay";
import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import type { SessionChatWork } from "@elevenex/shared";
import {
  IconButtonComponent,
  IconComponent,
  StatusGlyphComponent,
  TooltipDirective,
  type Status,
} from "../ui";
import {
  activitySections,
  eventRowView,
  formatElapsed,
  parseTime,
  type WorkRowView,
} from "./session-activity-model";
import { SessionEventRowComponent } from "./session-event-row.component";
import { SessionWorkRowComponent } from "./session-work-row.component";

/** Issues older than this stop flagging the trigger; they stay listed under Recent. */
const ISSUE_WINDOW_MS = 30 * 60_000;

/**
 * Session-level summary of work that outlives its turn and of runtime events
 * worth noticing. The trigger is absent when there is nothing to show, reads as
 * running work while live items exist, and flags recent failures until the
 * person opens it. The panel groups work that needs a decision above running
 * work; rows are presentational and the connected owner performs every action.
 */
@Component({
  selector: "ex-session-activity",
  imports: [
    OverlayModule,
    A11yModule,
    IconButtonComponent,
    IconComponent,
    StatusGlyphComponent,
    TooltipDirective,
    SessionEventRowComponent,
    SessionWorkRowComponent,
  ],
  templateUrl: "./session-activity.component.html",
  styleUrl: "./session-activity.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionActivityComponent {
  readonly work = input.required<SessionChatWork>();
  readonly provider = input("");
  /** Controls need a writable, reachable conversation. */
  readonly stopDisabled = input(false);
  /** Explains why controls are unavailable; shown at the top of the panel. */
  readonly disabledReason = input("");
  /** A stop command is in flight for this conversation. */
  readonly stopping = input(false);
  /** A move-to-background command is in flight for this conversation. */
  readonly backgrounding = input(false);
  /** The conversation holds an approval or question that Answer can focus. */
  readonly decisionPending = input(false);

  readonly stopRequested = output<string>();
  readonly inspectRequested = output<string>();
  readonly backgroundRequested = output<string>();
  /** Emitted after the panel has closed, so focus can move to the decision. */
  readonly answerRequested = output<void>();

  readonly open = signal(false);
  protected readonly now = signal(Date.now());
  protected readonly titleId = `session-activity-${crypto.randomUUID()}`;
  /** Issues at or before this time were seen when the panel was opened. */
  private readonly seenAt = signal(0);
  /** The row whose stop is in flight, so only it reads “Stopping…”. */
  protected readonly requested = signal<string | null>(null);
  private readonly injector = inject(Injector);

  protected readonly sections = computed(() => activitySections(this.work()));
  protected readonly recent = computed(() =>
    this.work().recent.map(eventRowView),
  );
  private readonly live = computed(() => this.work().running);
  protected readonly total = computed(
    () => this.work().totalRunning ?? this.live().length,
  );
  protected readonly waiting = computed(
    () => this.sections().needsYou.length,
  );
  /** Running count includes rows beyond the bounded list. */
  protected readonly runningTotal = computed(() =>
    Math.max(this.total() - this.waiting(), this.sections().running.length),
  );
  protected readonly controlsDisabled = computed(
    () => this.stopDisabled() || this.stopping() || this.backgrounding(),
  );

  protected readonly issues = computed(() => {
    const now = this.now();
    const seen = this.seenAt();
    return this.recent().filter(
      ({ event, at }) =>
        (event.tone === "warning" || event.tone === "danger") &&
        at !== null &&
        at > seen &&
        now - at < ISSUE_WINDOW_MS,
    );
  });
  protected readonly visible = computed(
    () => this.open() || this.live().length > 0 || this.recent().length > 0,
  );
  protected readonly mode = computed<"running" | "issue" | "quiet">(() =>
    this.live().length ? "running" : this.issues().length ? "issue" : "quiet",
  );
  protected readonly glyph = computed<Status>(() =>
    this.waiting()
      ? "attention"
      : this.mode() === "running"
        ? "running"
        : this.issues().some(({ event }) => event.tone === "danger")
          ? "failed"
          : "attention",
  );
  /** Elapsed time of the longest-running item: the one worth watching. */
  protected readonly oldestLabel = computed(() => {
    const starts = this.live()
      .map((item) => parseTime(item.startedAt))
      .filter((value) => value !== null);
    return starts.length
      ? formatElapsed(this.now() - Math.min(...starts))
      : "";
  });
  protected readonly triggerText = computed(() => {
    if (this.waiting()) return `${this.waiting()} needs you`;
    const count = this.total();
    if (count)
      return `${count} ${this.live().some((item) => item.background === false) ? "active" : "in background"}`;
    const issues = this.issues().length;
    return issues ? `${issues} ${issues === 1 ? "issue" : "issues"}` : "";
  });
  protected readonly triggerLabel = computed(() => {
    const oldest = this.oldestLabel();
    switch (this.mode()) {
      case "running":
        return `Delegated work: ${this.total()} active${this.waiting() ? `, ${this.waiting()} needs you` : ""}${oldest ? `, longest ${oldest}` : ""}`;
      case "issue":
        return `Activity: ${this.triggerText()}`;
      default:
        return "Recent activity";
    }
  });

  constructor() {
    // Seconds matter only while something runs; otherwise relative times are minute-grained.
    effect((cleanup) => {
      const period = this.live().length
        ? 1000
        : this.recent().length
          ? 30_000
          : 0;
      if (!period) return;
      this.now.set(Date.now());
      const timer = setInterval(() => this.now.set(Date.now()), period);
      cleanup(() => clearInterval(timer));
    });
    effect(() => {
      // A finished or failed stop releases its row's pending label.
      if (!this.stopping()) this.requested.set(null);
    });
  }

  toggle(): void {
    if (this.open()) this.close();
    else {
      this.now.set(Date.now());
      this.seenAt.set(Date.now());
      this.open.set(true);
    }
  }
  close(): void {
    this.open.set(false);
  }
  inspect(agentId: string): void {
    this.inspectRequested.emit(agentId);
  }
  background(row: WorkRowView): void {
    const id = row.item.agentId;
    if (row.item.canBackground && id && !this.controlsDisabled())
      this.backgroundRequested.emit(id);
  }
  stop(row: WorkRowView): void {
    if (!row.item.stoppable || this.controlsDisabled()) return;
    this.requested.set(row.item.id);
    this.stopRequested.emit(row.item.id);
  }
  answer(): void {
    this.close();
    // The focus trap restores focus to the trigger as the overlay detaches;
    // hand off only after that, so the owner's focus move wins.
    afterNextRender(() => this.answerRequested.emit(), {
      injector: this.injector,
    });
  }
}
