import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceNavigationObserver } from './workspace-navigation-observer';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('WorkspaceNavigationObserver', () => {
  it('reads the invalidation revision before the snapshot and refreshes only when it changes', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    let revision = 1;
    const read = vi.fn(async () => ({ ok: true as const, value: { revision, version: 1 as const } }));
    const changed = vi.fn(async () => undefined);
    const observer = new WorkspaceNavigationObserver(document, read, () => true, changed, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(read.mock.invocationCallOrder[0]).toBeLessThan(changed.mock.invocationCallOrder[0]!);
    await vi.advanceTimersByTimeAsync(5000); expect(changed).toHaveBeenCalledTimes(1);
    revision++;
    await vi.advanceTimersByTimeAsync(5000); expect(changed).toHaveBeenCalledTimes(2);
    observer.dispose();
    await vi.advanceTimersByTimeAsync(10000); expect(read).toHaveBeenCalledTimes(3);
  });

  it('pauses hidden/busy work and resumes on visibility without overlapping reads', async () => {
    vi.useFakeTimers();
    let hidden = false, ready = true;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const read = vi.fn(async () => ({ ok: true as const, value: { revision: 1, version: 1 as const } }));
    const observer = new WorkspaceNavigationObserver(document, read, () => ready, async () => undefined, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    ready = false; await vi.advanceTimersByTimeAsync(5000); expect(read).toHaveBeenCalledTimes(1);
    hidden = true; ready = true; await vi.advanceTimersByTimeAsync(5000); expect(read).toHaveBeenCalledTimes(1);
    hidden = false; document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0); expect(read).toHaveBeenCalledTimes(2);
    observer.dispose();
  });
  it('does not dispatch the initial snapshot to an incompatible backend', async () => {
    const changed = vi.fn(async () => undefined), failed = vi.fn();
    const observer = new WorkspaceNavigationObserver(document, async () => ({ ok: false, error: { code: 'http', status: 404, message: 'Not supported.' } }), () => true, changed, failed);
    await Promise.resolve(); await Promise.resolve();
    expect(changed).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledWith('This backend needs an update before it can open the workspace.');
    observer.dispose();
  });
});
