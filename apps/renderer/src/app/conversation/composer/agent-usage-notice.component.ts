import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from "@angular/core";
import {
  AutoHeightDirective,
  IconButtonComponent,
  IconComponent,
} from "../../ui";
import type { AgentConfig } from "../conversation.models";
import {
  limitingPlan,
  resetLabel,
  usageFraction,
  usagePercent,
} from "./agent-usage";

/** Read-only guidance. Scheduling, compaction and forks require explicit platform capabilities. */
@Component({
  selector: "ex-agent-usage-notice",
  imports: [AutoHeightDirective, IconButtonComponent, IconComponent],
  templateUrl: "./agent-usage-notice.component.html",
  styleUrl: "./agent-usage-notice.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AgentUsageNoticeComponent {
  readonly agent = input<AgentConfig>();
  readonly identity = input("");
  readonly dismissed = output<void>();
  private readonly dismissedKey = signal("");
  private readonly candidate = computed(() => {
    const agent = this.agent(),
      plan = agent?.plan;
    const limit = plan ? limitingPlan(plan) : undefined;
    const context = usageFraction(agent?.context);
    const exhausted = !!limit && limit.left <= 0;
    const kind = exhausted
      ? "plan-exhausted"
      : context >= 0.9
        ? "context-critical"
        : limit && limit.left <= 0.2
          ? "plan-low"
          : context >= 0.75
            ? "context-high"
            : null;
    if (!kind) return null;
    const quota = kind.startsWith("plan");
    return {
      key: `${this.identity()}:${kind}:${quota ? `${agent?.harness}:${limit?.id}:${limit?.reset}` : ""}`,
      danger: exhausted || kind === "context-critical",
      dismissible: kind === "plan-low" || kind === "context-high",
      text:
        quota && limit
          ? exhausted
            ? `${plan?.name || "Plan"} limit reached.`
            : `${usagePercent(limit.left)} of your ${limit.label.toLowerCase()} left.`
          : `Context ${usagePercent(context)} full.`,
      detail: quota
        ? limit?.reset
          ? `${resetLabel(limit.reset)}.`
          : "Reset time unavailable."
        : context >= 0.9
          ? "The agent may lose track of early details."
          : "Long conversations fill the agent’s context.",
    };
  });
  protected readonly notice = computed(() => {
    const notice = this.candidate();
    return notice?.dismissible && notice.key === this.dismissedKey()
      ? null
      : notice;
  });
  protected dismiss(): void {
    const notice = this.notice();
    if (notice?.dismissible) {
      this.dismissedKey.set(notice.key);
      this.dismissed.emit();
    }
  }
}
