import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from "@angular/core";
import type { AgentConfig } from "../conversation.models";
import { PresetCardComponent } from "./preset-card.component";
@Component({
  selector: "ex-preset-picker",
  imports: [PresetCardComponent],
  template: `<div
    role="group"
    aria-label="Agent presets"
    [class.compact]="compact()"
  >
    @for (
      preset of presets();
      track preset.preset || preset.model;
      let i = $index
    ) {
      <ex-preset-card
        [preset]="preset"
        [selected]="value() === (preset.preset || preset.model)"
        [shortcut]="i < 9 ? '⌥' + (i + 1) : ''"
        [compact]="compact()"
        (picked)="selected.emit(preset.preset || preset.model)"
      />
    }
    @if (custom()) {
      <ex-preset-card
        [custom]="true"
        [selected]="value() === 'custom'"
        [compact]="compact()"
        (picked)="selected.emit('custom')"
      />
    }
  </div>`,
  styles: `
    :host {
      display: block;
    }
    div {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: var(--space-2);
    }
    div.compact {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "(keydown)": "onKey($event)" },
})
export class PresetPickerComponent {
  readonly presets = input<readonly AgentConfig[]>([]);
  readonly value = input("");
  readonly compact = input(false);
  readonly custom = input(true);
  readonly selected = output<string>();
  onKey(event: KeyboardEvent): void {
    if (
      !event.altKey ||
      event.metaKey ||
      event.ctrlKey ||
      !/^[1-9]$/.test(event.key)
    )
      return;
    const preset = this.presets()[Number(event.key) - 1];
    if (preset) {
      event.preventDefault();
      this.selected.emit(preset.preset || preset.model);
    }
  }
}
