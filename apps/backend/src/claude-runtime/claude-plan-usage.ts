import type {
  AgentPlanUsage,
  AgentPlanUsageWindow,
} from '../agent-runtime/agent-runtime.types.js';

/** `none` means no API key; subscription auth can report it instead of `oauth`. */
export function allowsClaudePlanUsage(apiKeySource: unknown): boolean {
  return (
    apiKeySource == null || apiKeySource === 'oauth' || apiKeySource === 'none'
  );
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The SDK usage read uses percentages (0–100); stream events use fractions. */
export function claudeSubscriptionUsage(
  value: unknown,
): AgentPlanUsage | null | undefined {
  const usage = record(value);
  // This experimental SDK response must positively establish subscription limits.
  if (usage.rate_limits_available === false) return null;
  if (usage.rate_limits_available !== true) return undefined;
  const limits = record(usage.rate_limits);
  const windows: AgentPlanUsageWindow[] = [];
  const append = (id: string, label: string, value: unknown): void => {
    if (windows.length >= 8) return;
    const window = record(value);
    if (
      windows.some((window) => window.id === id) ||
      typeof window.utilization !== 'number' ||
      !Number.isFinite(window.utilization)
    )
      return;
    const reset =
      typeof window.resets_at === 'string'
        ? Date.parse(window.resets_at) / 1000
        : NaN;
    windows.push({
      id,
      label,
      remainingPercentage: Math.max(
        0,
        Math.min(100, Math.round(100 - window.utilization)),
      ),
      resetsAt: Number.isFinite(reset) && reset > 0 ? reset : null,
    });
  };
  append('five_hour', '5-hour limit', limits.five_hour);
  append('seven_day', 'Weekly limit', limits.seven_day);
  append(
    'seven_day_oauth_apps',
    'Weekly app limit',
    limits.seven_day_oauth_apps,
  );
  append('seven_day_sonnet', 'Weekly Sonnet limit', limits.seven_day_sonnet);
  append('seven_day_opus', 'Weekly Opus limit', limits.seven_day_opus);
  if (Array.isArray(limits.model_scoped)) {
    for (const value of limits.model_scoped.slice(0, 8)) {
      const model = record(value);
      if (typeof model.display_name !== 'string' || !model.display_name.trim())
        continue;
      const name = model.display_name.trim().slice(0, 60);
      append(`model_${name}`, `Weekly ${name} limit`, model);
    }
  }
  if (!windows.length) return undefined;
  const remaining = Math.min(
    ...windows.map((window) => window.remainingPercentage),
  );
  const subscription =
    typeof usage.subscription_type === 'string'
      ? usage.subscription_type
      : null;
  return {
    provider: 'claude',
    planName: subscription
      ? subscription.slice(0, 1).toUpperCase() + subscription.slice(1, 100)
      : null,
    status:
      remaining <= 0 ? 'exhausted' : remaining <= 20 ? 'warning' : 'available',
    windows,
    credits: null,
    updatedAt: new Date().toISOString(),
  };
}
