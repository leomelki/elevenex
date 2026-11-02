import { record } from './desktop-chat-projection.js';

/** Only expose bounded subscription facts, never authentication or provider payloads. */
export function chatPlanUsage(raw: Record<string, unknown>, provider: string) {
  if (
    (provider !== 'codex' && provider !== 'claude') ||
    (provider === 'codex'
      ? record(raw.authStatus).authMethod !== 'oauth'
      : record(raw.sessionMetadata).apiKeySource !== 'oauth')
  )
    return null;
  const plan = record(raw.planUsage);
  const status = plan.status;
  if (
    plan.provider !== provider ||
    (status !== 'available' && status !== 'warning' && status !== 'exhausted') ||
    typeof plan.updatedAt !== 'string' ||
    plan.updatedAt.length > 100 ||
    !Number.isFinite(Date.parse(plan.updatedAt)) ||
    !Array.isArray(plan.windows)
  )
    return null;
  const ids = new Set<string>();
  const windows = plan.windows.slice(0, 8).flatMap((value) => {
    const window = record(value);
    if (
      typeof window.id !== 'string' ||
      !window.id ||
      ids.has(window.id.slice(0, 100)) ||
      typeof window.label !== 'string' ||
      !window.label ||
      typeof window.remainingPercentage !== 'number' ||
      !Number.isFinite(window.remainingPercentage) ||
      window.remainingPercentage < 0 ||
      window.remainingPercentage > 100
    )
      return [];
    ids.add(window.id.slice(0, 100));
    return [
      {
        id: window.id.slice(0, 100),
        label: window.label.slice(0, 100),
        remainingPercentage: window.remainingPercentage,
        resetsAt:
          typeof window.resetsAt === 'number' &&
          Number.isFinite(window.resetsAt) &&
          window.resetsAt > 0 &&
          window.resetsAt <= 8.64e12
            ? window.resetsAt
            : null,
      },
    ];
  });
  return windows.length
    ? {
        provider,
        planName:
          typeof plan.planName === 'string'
            ? plan.planName.slice(0, 100)
            : null,
        status,
        windows,
        updatedAt: plan.updatedAt,
      }
    : null;
}
