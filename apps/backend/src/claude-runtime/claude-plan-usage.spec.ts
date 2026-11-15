import {
  allowsClaudePlanUsage,
  claudeSubscriptionUsage,
} from './claude-plan-usage.js';

describe('Claude subscription usage', () => {
  it('maps native percentages, plan names and ISO resets to the shared allowance contract', () => {
    expect(
      claudeSubscriptionUsage({
        rate_limits_available: true,
        subscription_type: 'max',
        rate_limits: {
          five_hour: { utilization: 12, resets_at: '2026-11-15T12:00:00Z' },
          seven_day: { utilization: 86, resets_at: null },
          seven_day_opus: { utilization: 0, resets_at: 'invalid' },
        },
      }),
    ).toMatchObject({
      provider: 'claude',
      planName: 'Max',
      status: 'warning',
      credits: null,
      windows: [
        {
          id: 'five_hour',
          label: '5-hour limit',
          remainingPercentage: 88,
          resetsAt: Date.parse('2026-11-15T12:00:00Z') / 1000,
        },
        {
          id: 'seven_day',
          label: 'Weekly limit',
          remainingPercentage: 14,
          resetsAt: null,
        },
        {
          id: 'seven_day_opus',
          label: 'Weekly Opus limit',
          remainingPercentage: 100,
          resetsAt: null,
        },
      ],
    });
  });

  it('bounds model windows and includes app limits without fabricating missing utilization', () => {
    const usage = claudeSubscriptionUsage({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: null },
        seven_day: { utilization: NaN },
        seven_day_opus: { utilization: Infinity },
        seven_day_oauth_apps: { utilization: 100 },
        model_scoped: Array.from({ length: 100 }, (_, i) => ({
          display_name: `Model ${i}`,
          utilization: 10,
        })),
      },
    });
    expect(usage?.windows).toHaveLength(8);
    expect(usage?.windows[0]).toMatchObject({
      id: 'seven_day_oauth_apps',
      remainingPercentage: 0,
    });
    expect(usage?.status).toBe('exhausted');
    expect(usage?.windows[1].label).toBe('Weekly Model 0 limit');
  });

  it('distinguishes explicit unavailability from failed or changed experimental replies', () => {
    expect(
      claudeSubscriptionUsage({
        rate_limits_available: false,
        rate_limits: null,
      }),
    ).toBeNull();
    for (const value of [
      null,
      {},
      { rate_limits_available: true, rate_limits: null },
    ]) {
      expect(claudeSubscriptionUsage(value)).toBeUndefined();
    }
  });

  it('accepts subscription facts before init and for no-API-key metadata, while excluding explicit API credentials', () => {
    for (const source of [undefined, null, 'oauth', 'none'])
      expect(allowsClaudePlanUsage(source)).toBe(true);
    for (const source of [
      'ANTHROPIC_API_KEY',
      'apiKeyHelper',
      '/login managed key',
      'unknown',
    ])
      expect(allowsClaudePlanUsage(source)).toBe(false);
  });
});
