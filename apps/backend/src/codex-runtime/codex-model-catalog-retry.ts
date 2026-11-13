const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;
export const CODEX_MODEL_CATALOG_TTL_MS = 10 * 60_000;

/** Owns background discovery cadence independently of connected windows. */
export class CodexModelCatalogRetry {
  private active = false;
  private timer: NodeJS.Timeout | null = null;
  private nextAttemptAt = 0;
  private retryIndex = 0;

  constructor(private readonly refresh: () => void) {}

  get waiting(): boolean {
    return this.active && Date.now() < this.nextAttemptAt;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    // A warm first read may be a cache hit, but still needs a future refresh.
    this.settled(true);
    this.refresh();
  }

  attemptStarted(): void {
    this.clearTimer();
  }

  settled(succeeded: boolean): void {
    const delay = succeeded
      ? CODEX_MODEL_CATALOG_TTL_MS
      : RETRY_DELAYS_MS[this.retryIndex];
    this.retryIndex = succeeded
      ? 0
      : Math.min(this.retryIndex + 1, RETRY_DELAYS_MS.length - 1);
    this.clearTimer();
    if (!this.active) return;
    this.nextAttemptAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextAttemptAt = 0;
      this.refresh();
    }, delay);
    this.timer.unref?.();
  }

  stop(): void {
    this.active = false;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAttemptAt = 0;
  }
}
