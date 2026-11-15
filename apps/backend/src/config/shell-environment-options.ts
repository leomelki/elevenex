export interface ShellEnvironmentOptions {
  readonly captureTimeoutMs: number;
  readonly queueTimeoutMs: number;
  readonly concurrency: number;
  readonly maxPending: number;
  readonly cacheEntries: number;
  readonly cacheBytes: number;
  readonly coldWaitMs: number;
  readonly bootstrapWaitMs: number;
}

/** Read once per backend lifetime; invalid configuration fails before startup. */
export function shellEnvironmentOptions(
  env: NodeJS.ProcessEnv,
): ShellEnvironmentOptions {
  const integer = (
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max
    )
      throw new Error(`${key} must be an integer between ${min} and ${max}.`);
    return value;
  };
  return {
    captureTimeoutMs: integer(
      'ELEVENEX_SHELL_CAPTURE_TIMEOUT_MS',
      15000,
      1000,
      120000,
    ),
    queueTimeoutMs: integer(
      'ELEVENEX_SHELL_QUEUE_TIMEOUT_MS',
      5000,
      100,
      30000,
    ),
    concurrency: integer('ELEVENEX_SHELL_CAPTURE_CONCURRENCY', 2, 1, 8),
    maxPending: integer('ELEVENEX_SHELL_MAX_PENDING_CAPTURES', 128, 1, 1024),
    cacheEntries: integer('ELEVENEX_SHELL_CACHE_ENTRIES', 256, 16, 2048),
    cacheBytes: integer(
      'ELEVENEX_SHELL_CACHE_BYTES',
      16 * 1024 * 1024,
      1024 * 1024,
      128 * 1024 * 1024,
    ),
    coldWaitMs: integer('ELEVENEX_SHELL_COLD_WAIT_MS', 20000, 100, 120000),
    bootstrapWaitMs: integer(
      'ELEVENEX_SHELL_BOOTSTRAP_WAIT_MS',
      8000,
      0,
      30000,
    ),
  };
}
