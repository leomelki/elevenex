import { applyPiActivity, type PiActivity } from './pi-activity.js';

describe('Pi native activity', () => {
  const state = (): PiActivity => ({
    retry: null,
    compact: null,
    notifications: [],
  });
  it('exposes retries only until completion and preserves exhausted errors', () => {
    const activity = state();
    applyPiActivity(activity, {
      type: 'auto_retry_start',
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1000,
      errorMessage: 'Overloaded',
    });
    expect(activity.retry).toMatchObject({
      attempt: 2,
      maxRetries: 3,
      retryDelayMs: 1000,
      error: 'Overloaded',
    });
    applyPiActivity(activity, {
      type: 'auto_retry_end',
      success: false,
      finalError: 'Retries exhausted',
    });
    expect(activity.retry).toBeNull();
    expect(activity.notifications[0]).toMatchObject({
      text: 'Retries exhausted',
      priority: 'high',
    });
  });
  it('maps successful, failed and cancelled compaction without inventing counts', () => {
    const activity = state();
    applyPiActivity(activity, {
      type: 'compaction_start',
      reason: 'threshold',
    });
    applyPiActivity(activity, {
      type: 'compaction_end',
      reason: 'threshold',
      result: { tokensBefore: 150000, estimatedTokensAfter: 32000 },
    });
    expect(activity.compact).toMatchObject({
      trigger: 'auto',
      preTokens: 150000,
      postTokens: 32000,
    });
    expect(activity.notifications).toEqual([]);
    applyPiActivity(activity, {
      type: 'auto_compaction_end',
      errorMessage: 'Summary failed',
    });
    expect(activity.notifications[0]).toMatchObject({
      text: 'Summary failed',
      priority: 'high',
    });
    applyPiActivity(activity, { type: 'compaction_end', aborted: true });
    expect(activity.notifications[0].text).toBe(
      'Context compaction interrupted',
    );
  });
});
