import type { AgentPlanLimit, AgentPlanUsage } from "../conversation.models";

export function usageFraction(value: number | undefined, fallback = 0): number {
  return Number.isFinite(value)
    ? Math.max(0, Math.min(1, value ?? fallback))
    : fallback;
}
export function planLimits(plan: AgentPlanUsage): readonly AgentPlanLimit[] {
  return (
    plan.windows?.map((limit) => ({
      ...limit,
      left: usageFraction(limit.left),
    })) ?? [
      ...(plan.win === undefined
        ? []
        : [
            {
              id: "window",
              label: "5-hour limit",
              left: usageFraction(plan.win),
              reset: plan.resetWin,
            },
          ]),
      ...(plan.week === undefined
        ? []
        : [
            {
              id: "week",
              label: "Weekly limit",
              left: usageFraction(plan.week),
              reset: plan.resetWeek,
              weekly: true,
            },
          ]),
    ]
  );
}
export function limitingPlan(plan: AgentPlanUsage): AgentPlanLimit {
  const limits = planLimits(plan);
  const limit = limits.reduce<AgentPlanLimit | undefined>(
    (lowest, limit) => (!lowest || limit.left < lowest.left ? limit : lowest),
    undefined,
  );
  return {
    ...(limit ?? { id: "plan", label: "Plan limit", left: 1 }),
    ...(plan.exhausted ? { left: 0 } : {}),
  };
}
export function usagePercent(value: number): string {
  return `${Math.round(usageFraction(value) * 100)}%`;
}
export function resetLabel(reset: string): string {
  return `Resets ${/^\d/.test(reset) ? "at " : ""}${reset}`;
}
