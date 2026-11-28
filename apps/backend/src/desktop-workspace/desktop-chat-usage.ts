import type {
  SessionChatModelQuota,
  SessionChatPlanUsage,
} from '@elevenex/shared';
import { record } from './desktop-chat-projection.js';
import { allowsClaudePlanUsage } from '../claude-runtime/claude-plan-usage.js';

/** Only expose bounded subscription facts, never authentication or provider payloads. */
export function chatPlanUsage(
  raw: Record<string, unknown>,
  provider: string,
): SessionChatPlanUsage | null {
  if (
    (provider !== 'codex' && provider !== 'claude') ||
    (provider === 'codex'
      ? record(raw.authStatus).authMethod !== 'oauth'
      : !allowsClaudePlanUsage(record(raw.sessionMetadata).apiKeySource))
  )
    return null;
  const plan = record(raw.planUsage);
  const status = plan.status;
  if (
    plan.provider !== provider ||
    (status !== 'available' &&
      status !== 'warning' &&
      status !== 'exhausted') ||
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

/** Per-model allowance; only providers that meter quota by model report it. */
export function chatModelQuota(
  raw: Record<string, unknown>,
  provider: string,
): SessionChatModelQuota | null {
  const quota = record(raw.modelQuota);
  if (
    provider !== 'antigravity' ||
    quota.provider !== provider ||
    typeof quota.updatedAt !== 'string' ||
    quota.updatedAt.length > 100 ||
    !Number.isFinite(Date.parse(quota.updatedAt)) ||
    !Array.isArray(quota.models)
  )
    return null;
  const ids = new Set<string>();
  const models = quota.models.slice(0, 32).flatMap((value) => {
    const model = record(value);
    const id = typeof model.id === 'string' ? model.id.slice(0, 1000) : '';
    const remaining = model.remainingPercentage;
    if (
      !id ||
      ids.has(id) ||
      typeof model.label !== 'string' ||
      typeof model.exhausted !== 'boolean' ||
      (remaining !== null &&
        (typeof remaining !== 'number' ||
          !Number.isFinite(remaining) ||
          remaining < 0 ||
          remaining > 100))
    )
      return [];
    ids.add(id);
    return [
      {
        id,
        label: model.label.slice(0, 1000) || id,
        remainingPercentage: remaining,
        exhausted: model.exhausted,
        resetsAt:
          typeof model.resetsAt === 'number' &&
          Number.isFinite(model.resetsAt) &&
          model.resetsAt > 0 &&
          model.resetsAt <= 8.64e12
            ? model.resetsAt
            : null,
      },
    ];
  });
  const tier =
    typeof quota.tier === 'string' && quota.tier.trim()
      ? quota.tier.trim().slice(0, 100)
      : null;
  return tier || models.length
    ? { provider, tier, models, updatedAt: quota.updatedAt }
    : null;
}
