import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  signal,
  input,
  output,
} from "@angular/core";
import { AutoHeightDirective } from "../../ui";
import type { AgentConfig } from "../conversation.models";
import { PresetCardComponent } from "./preset-card.component";
@Component({
  selector: "ex-preset-picker",
  imports: [PresetCardComponent, AutoHeightDirective],
  templateUrl: "./preset-picker.component.html",
  styleUrl: "./preset-picker.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "(keydown)": "onKey($event)" },
})
export class PresetPickerComponent {
  protected readonly ready = signal(false);
  constructor() {
    afterNextRender(() => this.ready.set(true));
  }
  readonly presets = input<readonly AgentConfig[]>([]);
  readonly value = input("");
  readonly compact = input(false);
  readonly custom = input(true);
  readonly disabled = input(false);
  readonly selected = output<string>();
  private shortcutNumber(event: KeyboardEvent): number {
    return Number(
      /^Digit[1-9]$/.test(event.code)
        ? event.code.slice(-1)
        : /^[1-9]$/.test(event.key)
          ? event.key
          : 0,
    );
  }
  onKey(event: KeyboardEvent): void {
    if (
      this.disabled() ||
      event.defaultPrevented ||
      event.isComposing ||
      event.shiftKey ||
      !event.altKey ||
      event.metaKey ||
      event.ctrlKey ||
      !this.shortcutNumber(event)
    )
      return;
    const preset = this.presets()[this.shortcutNumber(event) - 1];
    if (preset) {
      event.preventDefault();
      this.selected.emit(preset.id || preset.preset || preset.model);
    }
  }
}
