import type { AgentPlanUsage } from "../conversation.models";

export function usageFraction(value: number | undefined, fallback = 0): number {
  return Number.isFinite(value)
    ? Math.max(0, Math.min(1, value ?? fallback))
    : fallback;
}
export function limitingPlan(plan: AgentPlanUsage) {
  const window = usageFraction(plan.win, 1);
  const weekly = usageFraction(plan.week, 1);
  return plan.week !== undefined && weekly < window
    ? { left: weekly, weekly: true, reset: plan.resetWeek ?? "" }
    : { left: window, weekly: false, reset: plan.resetWin ?? "" };
}
export function usagePercent(value: number): string {
  return `${Math.round(usageFraction(value) * 100)}%`;
}
