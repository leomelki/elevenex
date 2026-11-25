import { AcpRequestError } from './acp-stdio.js';
import {
  AntigravityQuota,
  acpContextUsage,
  acpQuotaTier,
  antigravityQuotaFailure,
} from './antigravity-usage.js';

const now = Date.parse('2026-11-24T12:00:00Z');
const failure = (detail: string) =>
  new AcpRequestError(-32603, 'session/prompt', detail);

describe('Antigravity usage facts', () => {
  it('reads bounded ACP context reports', () => {
    expect(acpContextUsage({ used: 524288, size: 1048576 })).toEqual({
      totalTokens: 524288,
      maxTokens: 1048576,
      percentage: 50,
    });
    expect(acpContextUsage({ used: 2e6, size: 1e6 })?.percentage).toBe(100);
    for (const update of [
      {},
      { used: -1, size: 10 },
      { used: 1, size: 0 },
      { used: Number.NaN, size: 10 },
      { used: 1, size: 2e9 },
    ])
      expect(acpContextUsage(update)).toBeNull();
  });

  it('reads the account tier from Antigravity session metadata', () => {
    expect(
      acpQuotaTier({
        _meta: {
          antigravity: { tier: { name: ' Antigravity Starter Quota ' } },
        },
      }),
    ).toBe('Antigravity Starter Quota');
    expect(acpQuotaTier({ _meta: { antigravity: { tier: true } } })).toBeNull();
    expect(acpQuotaTier({})).toBeNull();
  });

  it('classifies exhausted quota and its reported reset', () => {
    expect(
      antigravityQuotaFailure(
        failure(
          'You have exhausted your capacity on this model. Your quota will reset after 1h2m3.5s.',
        ),
        now,
      ),
    ).toEqual({ resetsAt: Math.ceil((now + 3_723_500) / 1000) });
    expect(
      antigravityQuotaFailure(
        failure(
          'RESOURCE_EXHAUSTED {"details":[{"metadata":{"quotaResetTimeStamp":"2026-11-24T14:30:00Z"}}]}',
        ),
        now,
      ),
    ).toEqual({ resetsAt: Date.parse('2026-11-24T14:30:00Z') / 1000 });
    expect(
      antigravityQuotaFailure(
        failure('RESOURCE_EXHAUSTED {"retryDelay":"90s"}'),
        now,
      ),
    ).toEqual({ resetsAt: (now + 90_000) / 1000 });
  });

  it('keeps an implausible or missing reset unknown and ignores other failures', () => {
    expect(
      antigravityQuotaFailure(
        failure('You have exhausted your quota on this model.'),
        now,
      ),
    ).toEqual({ resetsAt: null });
    expect(
      antigravityQuotaFailure(
        failure(
          'RESOURCE_EXHAUSTED quotaResetTimeStamp: "2020-01-01T00:00:00Z"',
        ),
        now,
      ),
    ).toEqual({ resetsAt: null });
    expect(antigravityQuotaFailure(failure('Internal error'), now)).toBeNull();
    expect(
      antigravityQuotaFailure(new Error('RESOURCE_EXHAUSTED'), now),
    ).toBeNull();
  });

  it('shares model exhaustion until the reset or a completed turn', () => {
    // Unknown resets are retained relative to the real observation time.
    const now = Date.now();
    const changed = jest.fn();
    const quota = new AntigravityQuota(changed);
    expect(quota.snapshot(now)).toBeNull();
    quota.observeTier('Antigravity Starter Quota');
    quota.observeTier('Antigravity Starter Quota');
    expect(changed).toHaveBeenCalledTimes(1);
    const resetsAt = Math.ceil(now / 1000) + 60;
    quota.exhausted('opus', 'Claude Opus', resetsAt);
    quota.exhausted('flash', 'Gemini Flash', null);
    expect(quota.snapshot(now)?.models).toEqual([
      {
        id: 'opus',
        label: 'Claude Opus',
        remainingPercentage: 0,
        exhausted: true,
        resetsAt,
      },
      {
        id: 'flash',
        label: 'Gemini Flash',
        remainingPercentage: 0,
        exhausted: true,
        resetsAt: null,
      },
    ]);
    expect(
      quota.snapshot(now + 62_000)?.models.map((model) => model.id),
    ).toEqual(['flash']);
    quota.available('flash');
    quota.available('missing');
    expect(quota.snapshot(now + 62_000)).toMatchObject({
      tier: 'Antigravity Starter Quota',
      models: [],
    });
    expect(changed).toHaveBeenCalledTimes(4);
  });
});
