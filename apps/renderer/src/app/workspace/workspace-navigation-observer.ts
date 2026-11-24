import type { BackendResult, WorkspaceRevision } from '@elevenex/shared';

interface RevisionWaiter {
  wait(after: number, requestId: string): Promise<BackendResult<WorkspaceRevision>>;
  cancel(requestId: string): Promise<void>;
}

/** Owns the visible window's invalidation cursor and cancellable wait. Older
 * engines keep revision polling; newer engines wake directly on semantic changes.
 */
export class WorkspaceNavigationObserver {
  private timer?: ReturnType<typeof setTimeout>;
  private revision?: number;
  private reading = false;
  private stopped = false;
  private supportsWait = false;
  private resumeRequested = false;
  private requestId?: string;
  private readonly visible = () => {
    if (this.document.hidden) { clearTimeout(this.timer); this.cancelWait(); }
    else if (this.reading) this.resumeRequested = true;
    else void this.check();
  };

  constructor(
    private readonly document: Document,
    private readonly read: () => Promise<BackendResult<WorkspaceRevision>>,
    private readonly canRefresh: () => boolean,
    private readonly changed: () => Promise<void>,
    private readonly failed: (message: string) => void,
    private readonly waiter?: RevisionWaiter,
  ) {
    this.document.addEventListener('visibilitychange', this.visible);
    this.document.defaultView?.addEventListener('focus', this.visible);
    void this.check(true);
  }

  /** The focused conversation changed. Reuse the current watch slot immediately
   * so a later launch is observed against the new conversation's baseline. */
  restartWait(): void {
    if (this.stopped || this.document.hidden) return;
    if (this.reading) { this.resumeRequested = true; this.cancelWait(); }
    else void this.check();
  }

  dispose(): void {
    this.stopped = true; clearTimeout(this.timer); this.cancelWait();
    this.document.removeEventListener('visibilitychange', this.visible);
    this.document.defaultView?.removeEventListener('focus', this.visible);
  }

  private cancelWait(): void {
    if (this.requestId) void this.waiter?.cancel(this.requestId).catch(() => undefined);
  }

  private async check(initial = false): Promise<void> {
    if (this.stopped || this.reading) return;
    clearTimeout(this.timer);
    if (!initial && (this.document.hidden || !this.canRefresh())) { this.schedule(200); return; }
    this.reading = true;
    let delay = this.supportsWait ? 1000 : 5000;
    try {
      const requestId = this.supportsWait && this.revision !== undefined ? crypto.randomUUID() : undefined;
      this.requestId = requestId;
      const result = requestId && this.waiter && this.revision !== undefined
        ? await this.waiter.wait(this.revision, requestId) : await this.read();
      this.requestId = undefined;
      if (this.stopped || (!initial && (this.document.hidden || !this.canRefresh()))) { delay = 200; return; }
      if (result.ok && result.value.version === 1) {
        this.supportsWait = result.value.revisionWait === true && !!this.waiter;
        const changed = this.revision === undefined || result.value.revision !== this.revision;
        if (changed) await this.changed();
        // Advance only after successful reconciliation. Changes during reads
        // remain newer than this cursor and immediately wake the next wait.
        this.revision = result.value.revision;
        if (this.supportsWait) delay = 0;
      } else if (initial) this.failed(!result.ok && result.error.code === 'http' && result.error.status === 404 ? 'This backend needs an update before it can open the workspace.' : 'The workspace could not connect. Refresh to try again.');
    } catch { if (initial && !this.stopped) this.failed('The workspace could not connect. Refresh to try again.'); }
    finally {
      this.requestId = undefined; this.reading = false;
      if (this.resumeRequested) { delay = 0; this.resumeRequested = false; }
      this.schedule(delay);
    }
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    if (!this.stopped && !this.document.hidden) this.timer = setTimeout(() => { this.timer = undefined; void this.check(); }, delay);
  }
}
