import type { SessionChatModelQuota, SessionChatPlanUsage } from "@elevenex/shared";
import type { AgentPlanLimit, AgentPlanUsage } from "../conversation";

/** Reset timestamps are provider facts. Passing a reset never implies replenished quota. */
export function sessionPlanUsage(
  usage: SessionChatPlanUsage | null | undefined,
  now: number,
): AgentPlanUsage | undefined {
  if (!usage?.windows.length) return undefined;
  return {
    name: usage.provider === "codex" ? "Codex plan" : "Claude plan",
    tier: usage.planName ?? undefined,
    exhausted: usage.status === "exhausted",
    windows: usage.windows.map((window) => ({
      id: window.id,
      label: window.label,
      left: window.remainingPercentage / 100,
      weekly: /week/i.test(window.label),
      ...(window.resetsAt === null
        ? {}
        : resetTime(window.resetsAt * 1000, now)),
    })),
  };
}

/**
 * Per-model limits; each limit ID is its model ID. An exhaustion-only report ends at its
 * reported reset: the provider stated when the model becomes usable, and no
 * fraction exists to go stale. Reported fractions keep the "reset due" state.
 */
export function sessionModelLimits(
  quota: SessionChatModelQuota | null | undefined,
  now: number,
): readonly AgentPlanLimit[] {
  const limits: AgentPlanLimit[] = [];
  for (const model of quota?.models ?? []) {
    const reset = model.resetsAt === null ? null : model.resetsAt * 1000;
    if (model.remainingPercentage === null && reset !== null && reset <= now) continue;
    if (model.remainingPercentage === null && !model.exhausted) continue;
    limits.push({
      id: model.id,
      label: model.label,
      left: model.exhausted ? 0 : (model.remainingPercentage ?? 100) / 100,
      ...(reset === null ? {} : resetTime(reset, now)),
    });
  }
  return limits;
}

/** The selected model's allowance, presented through the shared plan surfaces. */
export function sessionModelPlan(
  quota: SessionChatModelQuota | null | undefined,
  limit: AgentPlanLimit | undefined,
  providerLabel: string,
): AgentPlanUsage | undefined {
  if (!quota || !limit) return undefined;
  return {
    name: providerLabel,
    tier: quota.tier ? quotaTier(quota.tier, providerLabel) : undefined,
    exhausted: limit.left <= 0,
    scope: "model",
    windows: [limit],
  };
}

/** "Antigravity Starter Quota" reads as "Starter Quota" under an "Antigravity" heading. */
function quotaTier(tier: string, providerLabel: string): string {
  const prefix = `${providerLabel} `;
  return tier.toLowerCase().startsWith(prefix.toLowerCase()) && tier.length > prefix.length
    ? tier.slice(prefix.length)
    : tier;
}

function resetTime(timestamp: number, now: number) {
  if (timestamp <= now)
    return { reset: "now · awaiting usage update", resetShort: "Reset due" };
  const date = new Date(timestamp);
  const clock = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (date.toDateString() === new Date(now).toDateString())
    return { reset: clock, resetShort: clock };
  return {
    reset: `${date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} at ${clock}`,
    resetShort: date.toLocaleDateString([], { weekday: "short" }),
  };
}
