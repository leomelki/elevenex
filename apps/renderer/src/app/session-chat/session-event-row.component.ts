import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from "@angular/core";
import { AutoHeightDirective, IconComponent } from "../ui";
import { formatAgo, type EventRowView } from "./session-activity-model";

/**
 * One noteworthy runtime event under Recent. Presentational: it owns only the
 * disclosure of long output, which resets whenever the panel closes.
 */
@Component({
  selector: "ex-session-event-row",
  imports: [AutoHeightDirective, IconComponent],
  templateUrl: "./session-event-row.component.html",
  styleUrls: [
    "./session-activity-row.css",
    "./session-event-row.component.css",
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: "event",
    role: "listitem",
    "[class.inspectable]": "!!view().event.agentId",
    "[attr.data-tone]": "view().event.tone",
    "[attr.data-kind]": "view().event.kind",
  },
})
export class SessionEventRowComponent {
  readonly view = input.required<EventRowView>();
  /** Wall-clock time from the panel's shared ticker. */
  readonly now = input.required<number>();
  readonly inspectRequested = output<string>();

  protected readonly outputId = `session-event-output-${crypto.randomUUID()}`;
  protected readonly expanded = signal(false);
  protected readonly ago = computed(() => {
    const at = this.view().at;
    return at === null ? "" : formatAgo(this.now() - at);
  });

  protected inspect(): void {
    const id = this.view().event.agentId;
    if (id) this.inspectRequested.emit(id);
  }
}
