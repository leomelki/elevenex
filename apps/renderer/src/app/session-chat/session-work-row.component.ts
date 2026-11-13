import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from "@angular/core";
import {
  ButtonComponent,
  IconButtonComponent,
  StatusGlyphComponent,
  TooltipDirective,
} from "../ui";
import { formatElapsed, type WorkRowView } from "./session-activity-model";

/**
 * One live agent or background task in the Activity panel. Presentational: it
 * renders a `WorkRowView` and emits intents; the panel's owner performs them.
 * Time and controls share one column — controls appear on hover or keyboard
 * focus (always on touch), so the resting list stays quiet and scannable.
 */
@Component({
  selector: "ex-session-work-row",
  imports: [
    ButtonComponent,
    IconButtonComponent,
    StatusGlyphComponent,
    TooltipDirective,
  ],
  templateUrl: "./session-work-row.component.html",
  styleUrls: ["./session-activity-row.css", "./session-work-row.component.css"],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: "work",
    role: "listitem",
    "[class.inspectable]": "view().inspectable",
    "[attr.data-status]": "view().item.status || 'running'",
  },
})
export class SessionWorkRowComponent {
  readonly view = input.required<WorkRowView>();
  /** Wall-clock time from the panel's shared ticker. */
  readonly now = input.required<number>();
  /** No control may run: the conversation is unavailable or another action is in flight. */
  readonly controlsDisabled = input(false);
  /** This row's stop request is in flight. */
  readonly stopping = input(false);
  /** A move-to-background request is in flight. */
  readonly backgrounding = input(false);
  /** The main conversation holds an approval or question that can be answered now. */
  readonly decisionPending = input(false);

  readonly inspectRequested = output<string>();
  readonly stopRequested = output<void>();
  readonly backgroundRequested = output<void>();
  readonly answerRequested = output<void>();

  protected readonly elapsed = computed(() => {
    const start = this.view().startedAt;
    return start === null ? "" : formatElapsed(this.now() - start);
  });
  protected readonly pendingLabel = computed(() =>
    this.stopping()
      ? "Stopping…"
      : this.backgrounding() && this.view().item.canBackground
        ? "Moving…"
        : "",
  );
  protected readonly answerable = computed(
    () => this.view().item.status === "waiting" && this.decisionPending(),
  );

  protected inspect(): void {
    const id = this.view().item.agentId;
    if (this.view().inspectable && id) this.inspectRequested.emit(id);
  }
}
