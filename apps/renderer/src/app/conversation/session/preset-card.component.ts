import {
  ChangeDetectionStrategy,
  Component,
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
  readonly picked = output<void>();
}
