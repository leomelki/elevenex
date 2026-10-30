import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from "@angular/core";
import { ContextMeterComponent } from "../../ui";
import type { AgentConfig } from "../conversation.models";
import {
  limitingPlan,
  planLimits,
  resetLabel,
  usageFraction,
  usagePercent,
} from "./agent-usage";

/** Read-only usage shared by the hover card and the editable agent popover. */
@Component({
  selector: "ex-agent-usage",
  imports: [ContextMeterComponent],
  templateUrl: "./agent-usage.component.html",
  styleUrl: "./agent-usage.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AgentUsageComponent {
  readonly agent = input.required<AgentConfig>();
  readonly canCompact = input(false);
  readonly disabled = input(false);
  readonly compactRequested = output<void>();
  protected readonly context = computed(() =>
    usageFraction(this.agent().context),
  );
  protected readonly limits = computed(() => {
    const plan = this.agent().plan;
    if (!plan) return [];
    const bound = limitingPlan(plan);
    return planLimits(plan).map((limit) => ({
      ...limit,
      tight: limit.id === bound.id,
    }));
  });
  protected readonly percent = usagePercent;
  protected readonly resetLabel = resetLabel;
}
