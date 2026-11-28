import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
  output,
} from "@angular/core";
import { TaskLineComponent } from "../../tasks/lifecycle/task-line.component";
import type { TaskContext } from "../../tasks/task.models";
import type { AgentConfig, SessionTask } from "../conversation.models";
import { PresetPickerComponent } from "./preset-picker.component";
@Component({
  selector: "ex-session-start",
  imports: [TaskLineComponent, PresetPickerComponent],
  templateUrl: "./session-start.component.html",
  styleUrl: "./session-start.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "(keydown)": "onKey($event)" },
})
export class SessionStartComponent {
  readonly presets = input<readonly AgentConfig[]>([]);
  readonly value = input<string>();
  readonly task = input<SessionTask>();
  readonly title = input("What should we work on?");
  readonly presetSelected = output<string>();
  readonly renameTask = output<void>();
  readonly renameBranch = output<string>();
  readonly copyBranch = output<string>();
  readonly taskContext = computed<TaskContext | null>(() => {
    const task = this.task();
    return task
      ? { ...task, project: task.project ? { name: task.project } : undefined }
      : null;
  });
  readonly visiblePresets = computed(() => this.presets().slice(0, 6));
  readonly localSelection = linkedSignal(() => this.value() ?? null);
  readonly selected = computed(
    () =>
      this.localSelection() ??
      this.visiblePresets()[0]?.id ??
      this.visiblePresets()[0]?.preset ??
      this.visiblePresets()[0]?.model ??
      "custom",
  );
  select(value: string): void {
    this.localSelection.set(value);
    this.presetSelected.emit(value);
  }
  onKey(event: KeyboardEvent): void {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      !event.altKey ||
      !/^[1-9]$/.test(
        /^Digit[1-9]$/.test(event.code) ? event.code.slice(-1) : event.key,
      )
    )
      return;
    const preset =
      this.visiblePresets()[
        Number(
          /^Digit[1-9]$/.test(event.code) ? event.code.slice(-1) : event.key,
        ) - 1
      ];
    if (preset) {
      event.preventDefault();
      this.select(preset.id || preset.preset || preset.model);
    }
  }
}
