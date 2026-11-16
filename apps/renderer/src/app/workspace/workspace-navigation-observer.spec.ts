import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceNavigationObserver } from './workspace-navigation-observer';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('WorkspaceNavigationObserver', () => {
  it('wakes directly on revisions, coalesces changes during reconciliation and cancels the outstanding wait', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    let wake!: (revision: number) => void;
    let after = -1;
    const wait = vi.fn((revision: number) => {
      after = revision;
      return new Promise<import('@elevenex/shared').BackendResult<import('@elevenex/shared').WorkspaceRevision>>(resolve => {
        wake = next => resolve({ ok: true, value: { revision: next, version: 1, revisionWait: true } });
      });
    });
    const cancel = vi.fn(async () => wake(after));
    let release!: () => void;
    const changed = vi.fn(async (): Promise<void> => undefined);
    const observer = new WorkspaceNavigationObserver(document, async () => ({ ok: true, value: { revision: 1, version: 1, revisionWait: true } }), () => true, changed, vi.fn(), { wait, cancel });
    await vi.advanceTimersByTimeAsync(1);
    expect(wait).toHaveBeenCalledWith(1, expect.any(String));
    changed.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    wake(2); await vi.advanceTimersByTimeAsync(1);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
    release(); await vi.advanceTimersByTimeAsync(1);
    expect(wait).toHaveBeenCalledWith(2, expect.any(String));
    wake(50); await vi.advanceTimersByTimeAsync(1);
    expect(changed).toHaveBeenCalledTimes(3);
    observer.dispose(); await vi.advanceTimersByTimeAsync(10000);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(3);
  });

  it('cancels on hide, rejects busy replies and resumes without losing the revision', async () => {
    vi.useFakeTimers(); let hidden = false, ready = true;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    let wake!: () => void;
    const wait = vi.fn(() => new Promise<import('@elevenex/shared').BackendResult<import('@elevenex/shared').WorkspaceRevision>>(resolve => {
      wake = () => resolve({ ok: true, value: { revision: 2, version: 1, revisionWait: true } });
    }));
    const cancel = vi.fn(async () => wake());
    const changed = vi.fn(async (): Promise<void> => undefined);
    const observer = new WorkspaceNavigationObserver(document, async () => ({ ok: true, value: { revision: 1, version: 1, revisionWait: true } }), () => ready, changed, vi.fn(), { wait, cancel });
    await vi.advanceTimersByTimeAsync(1);
    hidden = true; document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1);
    expect(cancel).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledTimes(1);
    hidden = false; document.dispatchEvent(new Event('visibilitychange')); ready = false;
    wake(); await vi.advanceTimersByTimeAsync(200);
    expect(changed).toHaveBeenCalledTimes(1);
    ready = true; await vi.advanceTimersByTimeAsync(200);
    expect(wait).toHaveBeenLastCalledWith(1, expect.any(String));
    wake(); await vi.advanceTimersByTimeAsync(1);
    expect(changed).toHaveBeenCalledTimes(2);
    observer.dispose();
  });

  it('rechecks immediately when shown before a cancelled wait has settled', async () => {
    vi.useFakeTimers(); let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    let finish!: () => void;
    const wait = vi.fn(() => new Promise<import('@elevenex/shared').BackendResult<import('@elevenex/shared').WorkspaceRevision>>(resolve => {
      finish = () => resolve({ ok: false, error: { code: 'timeout', message: 'Cancelled' } });
    }));
    const observer = new WorkspaceNavigationObserver(document, async () => ({ ok: true, value: { revision: 1, version: 1, revisionWait: true } }), () => true, async () => undefined, vi.fn(), { wait, cancel: async () => undefined });
    await vi.advanceTimersByTimeAsync(1);
    hidden = true; document.dispatchEvent(new Event('visibilitychange'));
    hidden = false; document.dispatchEvent(new Event('visibilitychange'));
    finish(); await vi.advanceTimersByTimeAsync(1);
    expect(wait).toHaveBeenCalledTimes(2);
    observer.dispose(); finish();
  });

  it('retries a revision whose background reconciliation failed', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    let revision = 1;
    const changed = vi.fn(async () => undefined), failed = vi.fn();
    const observer = new WorkspaceNavigationObserver(document, async () => ({ ok: true, value: { revision, version: 1 } }), () => true, changed, failed);
    await vi.advanceTimersByTimeAsync(0);
    revision++;
    changed.mockRejectedValueOnce(new Error('Transient failure'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(changed).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(changed).toHaveBeenCalledTimes(3);
    observer.dispose();
  });

  it('reads the invalidation revision before the snapshot and refreshes only when it changes', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    let revision = 1;
    const read = vi.fn(async () => ({ ok: true as const, value: { revision, version: 1 as const } }));
    const changed = vi.fn(async (): Promise<void> => undefined);
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
