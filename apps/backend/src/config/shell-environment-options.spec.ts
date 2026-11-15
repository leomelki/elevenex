import { shellEnvironmentOptions } from './shell-environment-options.js';

describe('shell capture resource configuration', () => {
  it('uses bounded defaults appropriate for slow shells and many workspaces', () => {
    expect(shellEnvironmentOptions({})).toEqual({
      captureTimeoutMs: 15000,
      queueTimeoutMs: 5000,
      concurrency: 2,
      maxPending: 128,
      cacheEntries: 256,
      cacheBytes: 16 * 1024 * 1024,
      coldWaitMs: 20000,
      bootstrapWaitMs: 8000,
    });
  });
  it('accepts explicit enterprise startup budgets without lifting other limits', () => {
    expect(
      shellEnvironmentOptions({
        ELEVENEX_SHELL_CAPTURE_TIMEOUT_MS: '60000',
        ELEVENEX_SHELL_CACHE_ENTRIES: '1024',
      }),
    ).toMatchObject({
      captureTimeoutMs: 60000,
      cacheEntries: 1024,
      concurrency: 2,
      maxPending: 128,
    });
  });
  it.each(['0', '-1', 'Infinity', '1.5', '120001', 'secret-not-a-number'])(
    'rejects invalid timeout configuration without printing its value',
    (value) => {
      expect(() =>
        shellEnvironmentOptions({ ELEVENEX_SHELL_CAPTURE_TIMEOUT_MS: value }),
      ).toThrow('ELEVENEX_SHELL_CAPTURE_TIMEOUT_MS must be an integer');
    },
  );
});
