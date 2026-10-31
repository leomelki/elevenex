import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from "@angular/core";
import { IconComponent, KbdComponent } from "../../ui";
import type { AgentConfig } from "../conversation.models";
@Component({
  selector: "ex-preset-card",
  imports: [IconComponent, KbdComponent],
  templateUrl: "./preset-card.component.html",
  styleUrl: "./preset-card.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PresetCardComponent {
  readonly preset = input<AgentConfig>();
  readonly selected = input(false);
  readonly shortcut = input("");
  readonly custom = input(false);
  readonly compact = input(false);
  readonly disabled = input(false);
  readonly thinking = computed(() => {
    const value = this.preset()?.thinking;
    return value === "xhigh"
      ? "Extra high"
      : value
        ? value.charAt(0).toUpperCase() + value.slice(1)
        : "";
  });
  readonly picked = output<void>();
}
