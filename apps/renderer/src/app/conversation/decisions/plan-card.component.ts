import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from "@angular/core";
import {
  AutoHeightDirective,
  ButtonComponent,
  IconComponent,
  StatusGlyphComponent,
} from "../../ui";
import type { PlanStep } from "../conversation.models";
@Component({
  selector: "ex-plan-card",
  imports: [
    AutoHeightDirective,
    ButtonComponent,
    IconComponent,
    StatusGlyphComponent,
  ],
  templateUrl: "./plan-card.component.html",
  styleUrl: "./plan-card.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanCardComponent {
  readonly title = input("Plan");
  readonly steps = input<readonly PlanStep[]>([]);
  readonly status = input<"proposed" | "running" | "done">("proposed");
  readonly start = output<void>();
  readonly refine = output<void>();
  readonly done = computed(
    () => this.steps().filter((step) => step.state === "done").length,
  );
  readonly progress = computed(() =>
    this.steps().length ? this.done() / this.steps().length : 0,
  );
}
