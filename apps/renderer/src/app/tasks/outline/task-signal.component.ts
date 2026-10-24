import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from "@angular/core";
import { StatusGlyphComponent, TickerComponent } from "../../ui";

/** Keep each signal mounted so its ink changes without moving the title. */
@Component({
  selector: "ex-task-signal",
  imports: [StatusGlyphComponent, TickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[attr.title]": "description()" },
  templateUrl: "./task-signal.component.html",
  styleUrl: "./task-signal.component.css",
})
export class TaskSignalComponent {
  readonly attention = input(0);
  readonly running = input(0);
  readonly total = input(0);
  readonly collapsed = input(false);
  protected readonly description = computed(() =>
    this.attention()
      ? `${this.attention()} ${this.attention() === 1 ? "session needs" : "sessions need"} you`
      : this.running()
        ? `${this.running()} working`
        : null,
  );
}
