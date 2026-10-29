import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from "@angular/core";
import { ContextMeterComponent } from "../../ui";
import type { AgentConfig } from "../conversation.models";
import { limitingPlan, usageFraction, usagePercent } from "./agent-usage";

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
    return [
      {
        id: "window",
        label: "5-hour limit",
        left: usageFraction(plan.win, 1),
        reset: plan.resetWin,
        tight: !bound.weekly,
      },
      ...(plan.week === undefined
        ? []
        : [
            {
              id: "week",
              label: "Weekly limit",
              left: usageFraction(plan.week, 1),
              reset: plan.resetWeek,
              tight: bound.weekly,
            },
          ]),
    ];
  });
  protected readonly percent = usagePercent;
  protected resetLabel(reset: string): string {
    return `Resets ${/^\d/.test(reset) ? "at " : ""}${reset}`;
  }
}
