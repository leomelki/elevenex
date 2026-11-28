import { acpObject, AcpRequestError } from './acp-stdio.js';
import { acpText } from './antigravity-acp.js';

/** Shape read by the desktop chat projection's `contextUsage` reader. */
export interface AntigravityContextUsage {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
}

/**
 * Account allowance for one model. Antigravity meters quota per model, so a
 * failure on one model says nothing about the others.
 */
export interface AntigravityModelQuota {
  id: string;
  label: string;
  /** 0–100 when the CLI reports a fraction; null when only exhaustion is known. */
  remainingPercentage: number | null;
  exhausted: boolean;
  /** Unix seconds. */
  resetsAt: number | null;
}

export interface AntigravityQuotaSnapshot {
  provider: 'antigravity';
  tier: string | null;
  models: AntigravityModelQuota[];
  updatedAt: string;
}

const TOKEN_LIMIT = 1e9;
const MODEL_LIMIT = 32;
/** Without a reported reset, a later successful turn is the only proof of renewal. */
const UNKNOWN_RESET_RETENTION = 24 * 60 * 60_000;
const MAX_RESET_DELAY = 31 * 24 * 60 * 60_000;

/** ACP `usage_update`: tokens currently in the context window and its size. */
export function acpContextUsage(
  update: Record<string, unknown>,
): AntigravityContextUsage | null {
  const { used, size } = update;
  if (
    typeof used !== 'number' ||
    typeof size !== 'number' ||
    !Number.isFinite(used) ||
    !Number.isFinite(size) ||
    used < 0 ||
    size <= 0 ||
    used > TOKEN_LIMIT ||
    size > TOKEN_LIMIT
  )
    return null;
  const totalTokens = Math.round(used);
  const maxTokens = Math.round(size);
  return {
    totalTokens,
    maxTokens,
    percentage: Math.min(
      100,
      Math.round((totalTokens / maxTokens) * 1000) / 10,
    ),
  };
}

/** `_meta.antigravity.tier` on session/new, load and resume results. */
export function acpQuotaTier(result: Record<string, unknown>): string | null {
  const tier = acpObject(acpObject(acpObject(result._meta).antigravity).tier);
  return acpText(tier.name, 100).trim() || null;
}

const QUOTA_FAILURE =
  /RESOURCE_EXHAUSTED|exhausted your (?:capacity|quota)|out of quota|quota (?:exceeded|will reset)/i;
const GO_DURATION = /^(?:\d+(?:\.\d+)?(?:h|ms|m|s))+$/;
const RESET_PATTERNS: readonly RegExp[] = [
  /quotaResetTimeStamp\\?"?\s*[:=]\s*\\?"?(\d{4}-\d\d-\d\dT[0-9:.]+(?:Z|[+-]\d\d:?\d\d))/i,
  /quotaResetDelay\\?"?\s*[:=]\s*\\?"?((?:\d+(?:\.\d+)?(?:h|ms|m|s))+)/i,
  /resets? (?:after|in) ((?:\d+(?:\.\d+)?(?:h|ms|m|s))+)/i,
  /retryDelay\\?"?\s*[:=]\s*\\?"?(\d+(?:\.\d+)?s)/i,
];

function durationMs(value: string): number | null {
  if (!GO_DURATION.test(value)) return null;
  let total = 0;
  for (const [, amount, unit] of value.matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s)/g))
    total +=
      Number(amount) *
      (unit === 'h'
        ? 3_600_000
        : unit === 'm'
          ? 60_000
          : unit === 's'
            ? 1_000
            : 1);
  return Number.isFinite(total) ? total : null;
}

/**
 * Classifies an ACP prompt failure as exhausted model quota. The reset is a
 * provider fact parsed from Google's error text or structured details, not an
 * estimate; a missing or implausible reset is reported as unknown.
 */
export function antigravityQuotaFailure(
  error: unknown,
  now = Date.now(),
): { resetsAt: number | null } | null {
  if (!(error instanceof AcpRequestError) || !QUOTA_FAILURE.test(error.detail))
    return null;
  for (const pattern of RESET_PATTERNS) {
    const match = pattern.exec(error.detail)?.[1];
    if (!match) continue;
    const at = /^\d{4}-/.test(match)
      ? Date.parse(match)
      : now + (durationMs(match) ?? NaN);
    if (Number.isFinite(at) && at > now && at - now <= MAX_RESET_DELAY)
      return { resetsAt: Math.ceil(at / 1000) };
  }
  return { resetsAt: null };
}

/**
 * Account-wide quota facts shared by every Antigravity conversation in this
 * backend. The provider owns one instance; `changed` fans updates out to the
 * conversations that are currently connected.
 */
export class AntigravityQuota {
  private tier: string | null = null;
  private readonly models = new Map<
    string,
    { quota: AntigravityModelQuota; observedAt: number }
  >();
  private updatedAt = new Date(0).toISOString();

  constructor(private readonly changed: () => void) {}

  observeTier(tier: string | null): void {
    if (!tier || tier === this.tier) return;
    this.tier = tier;
    this.touch();
  }

  exhausted(id: string, label: string, resetsAt: number | null): void {
    if (!id) return;
    this.models.delete(id);
    this.models.set(id, {
      quota: {
        id,
        label: label || id,
        remainingPercentage: 0,
        exhausted: true,
        resetsAt,
      },
      observedAt: Date.now(),
    });
    for (const oldest of this.models.keys()) {
      if (this.models.size <= MODEL_LIMIT) break;
      this.models.delete(oldest);
    }
    this.touch();
  }

  /** A completed turn proves the model is usable again. */
  available(id: string | undefined): void {
    if (id && this.models.delete(id)) this.touch();
  }

  snapshot(now = Date.now()): AntigravityQuotaSnapshot | null {
    for (const [id, { quota, observedAt }] of this.models) {
      const expired =
        quota.resetsAt === null
          ? now - observedAt > UNKNOWN_RESET_RETENTION
          : quota.resetsAt * 1000 <= now;
      if (expired) this.models.delete(id);
    }
    if (!this.tier && !this.models.size) return null;
    return {
      provider: 'antigravity',
      tier: this.tier,
      models: [...this.models.values()].map(({ quota }) => ({ ...quota })),
      updatedAt: this.updatedAt,
    };
  }

  private touch(): void {
    this.updatedAt = new Date().toISOString();
    this.changed();
  }
}
