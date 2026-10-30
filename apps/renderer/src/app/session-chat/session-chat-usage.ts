import type { SessionChatPlanUsage } from "@elevenex/shared";
import type { AgentPlanUsage } from "../conversation";

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
