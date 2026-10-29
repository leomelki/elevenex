import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from "@angular/core";
import type { AgentPlanUsage } from "../conversation.models";
import { limitingPlan, usagePercent } from "./agent-usage";

@Component({
  selector: "ex-agent-plan-meter",
  templateUrl: "./agent-plan-meter.component.html",
  styleUrl: "./agent-plan-meter.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: "img",
    "[attr.aria-label]": "description()",
    "[attr.data-tone]":
      'limit().left <= 0 ? "danger" : limit().left <= .2 ? "attention" : "normal"',
  },
})
export class AgentPlanMeterComponent {
  readonly plan = input.required<AgentPlanUsage>();
  readonly compact = input(true);
  protected readonly limit = computed(() => limitingPlan(this.plan()));
  protected readonly circumference = 2 * Math.PI * 5.25;
  protected readonly label = computed(() =>
    this.limit().left <= 0
      ? this.limit().reset
      : usagePercent(this.limit().left),
  );
  protected readonly description = computed(() =>
    this.limit().left <= 0
      ? `Plan limit reached${this.limit().reset ? ", resets " + this.limit().reset : ""}`
      : `${usagePercent(this.limit().left)} of the ${this.limit().weekly ? "weekly" : "5-hour"} limit left`,
  );
}
