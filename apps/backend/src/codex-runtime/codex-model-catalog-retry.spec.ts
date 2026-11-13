import { CodexModelCatalogRetry } from './codex-model-catalog-retry.js';

describe('Codex background model discovery', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('keeps retrying without a window, backing off to five minutes', () => {
    const refresh = jest.fn();
    const retry = new CodexModelCatalogRetry(refresh);
    retry.start();
    expect(refresh).toHaveBeenCalledTimes(1);
    for (const [index, delay] of [
      15_000, 30_000, 60_000, 120_000, 300_000, 300_000,
    ].entries()) {
      retry.settled(false);
      expect(retry.waiting).toBe(true);
      jest.advanceTimersByTime(delay - 1);
      expect(refresh).toHaveBeenCalledTimes(index + 1);
      jest.advanceTimersByTime(1);
      expect(refresh).toHaveBeenCalledTimes(index + 2);
    }
    retry.stop();
  });

  it('continues healthy refreshes and resets the failure backoff after recovery', () => {
    const refresh = jest.fn();
    const retry = new CodexModelCatalogRetry(refresh);
    retry.start();
    retry.settled(false);
    jest.advanceTimersByTime(15_000);
    retry.settled(true);
    jest.advanceTimersByTime(600_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    retry.settled(false);
    jest.advanceTimersByTime(15_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    retry.stop();
  });

  it('replaces scheduled work when a foreground attempt starts and cleans up on shutdown', () => {
    const refresh = jest.fn();
    const retry = new CodexModelCatalogRetry(refresh);
    retry.start();
    retry.settled(false);
    retry.attemptStarted();
    jest.advanceTimersByTime(15_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    retry.settled(false);
    retry.stop();
    retry.settled(false); // A late completion must not resurrect shutdown work.
    jest.advanceTimersByTime(600_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
