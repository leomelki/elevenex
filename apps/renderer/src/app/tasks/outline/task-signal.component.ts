import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from "@angular/core";
import { StatusGlyphComponent, TickerComponent } from "../../ui";
import type { TaskWorkspaceSignal } from "../task.models";

/**
 * Keep each signal mounted so its ink changes without moving the title. A
 * workspace that isn't ready speaks first: its sessions can't work until it is.
 */
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
  readonly workspace = input<TaskWorkspaceSignal>();
  protected readonly description = computed(() =>
    this.workspace()?.description ??
    (this.attention()
      ? `${this.attention()} ${this.attention() === 1 ? "session needs" : "sessions need"} you`
      : this.running()
        ? `${this.running()} working`
        : null),
  );
}
