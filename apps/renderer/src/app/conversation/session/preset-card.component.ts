import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from "@angular/core";
import { IconComponent, KbdComponent } from "../../ui";
import type { AgentConfig } from "../conversation.models";
import { AgentMarkComponent } from "../composer/agent-mark.component";
@Component({
  selector: "ex-preset-card",
  imports: [AgentMarkComponent, IconComponent, KbdComponent],
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
  readonly adaptive = input(false);
  readonly slim = input(false);
  readonly editing = input(false);
  readonly edited = input(false);
  readonly thinking = computed(() => {
    const value = this.preset()?.thinking;
    return value === "xhigh"
      ? "Extra high"
      : value
        ? value.charAt(0).toUpperCase() + value.slice(1)
        : "";
  });
  protected readonly modelSummary = computed(() => {
    const preset = this.preset();
    const model = preset?.modelLabel || preset?.model || "Provider default";
    const thinking = this.thinking();
    return thinking ? `${model} · ${thinking}` : model;
  });
  readonly picked = output<void>();
}
