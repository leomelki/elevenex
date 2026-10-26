import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from "@angular/core";
import { IconComponent, StatusGlyphComponent, TickerComponent } from "../../ui";
import type { TaskSession } from "../task.models";
@Component({
  selector: "ex-session-row",
  imports: [IconComponent, StatusGlyphComponent, TickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./session-row.component.html",
  styleUrl: "./session-row.component.css",
})
export class SessionRowComponent {
  readonly session = input.required<TaskSession>();
  readonly selected = input(false);
  readonly depth = input(0);
  /** Task context for a shortcut outside the task outline. */
  readonly context = input<string | null>(null);
  readonly activated = output<string>();
  protected readonly kindIcon = computed(() =>
    this.session().kind === "fork"
      ? "fork"
      : this.session().kind === "side"
        ? "side-chat"
        : this.session().kind === "auto"
          ? "bolt"
          : null,
  );
}
