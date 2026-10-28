import type { BackendResult } from '@elevenex/shared';

/** Owns one cheap invalidation cursor, timer and visibility listener per backend lease.
 * A changed revision refreshes only the currently visible bounded resource windows.
 */
export class WorkspaceNavigationObserver {
  private timer?: ReturnType<typeof setTimeout>;
  private revision?: number;
  private reading = false;
  private stopped = false;
  private readonly visible = () => { if (!this.document.hidden) void this.check(); };

  constructor(
    private readonly document: Document,
    private readonly read: () => Promise<BackendResult<{ readonly revision: number; readonly version: 1 }>>,
    private readonly canRefresh: () => boolean,
    private readonly changed: () => Promise<void>,
    private readonly failed: (message: string) => void,
  ) {
    this.document.addEventListener('visibilitychange', this.visible);
    this.document.defaultView?.addEventListener('focus', this.visible);
    void this.check(true);
  }

  dispose(): void {
    this.stopped = true; clearTimeout(this.timer);
    this.document.removeEventListener('visibilitychange', this.visible);
    this.document.defaultView?.removeEventListener('focus', this.visible);
  }

  private async check(initial = false): Promise<void> {
    if (this.stopped || this.reading) return;
    clearTimeout(this.timer);
    if (!initial && (this.document.hidden || !this.canRefresh())) { this.schedule(); return; }
    this.reading = true;
    try {
      const result = await this.read();
      if (this.stopped) return;
      if (result.ok && result.value.version === 1) {
        const changed = this.revision === undefined || result.value.revision !== this.revision;
        this.revision = result.value.revision;
        if (changed) await this.changed();
      } else if (initial) this.failed(!result.ok && result.error.code === 'http' && result.error.status === 404 ? 'This backend needs an update before it can open the workspace.' : 'The workspace could not connect. Refresh to try again.');
    } catch { if (initial && !this.stopped) this.failed('The workspace could not connect. Refresh to try again.'); }
    finally { this.reading = false; this.schedule(); }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (!this.stopped && !this.document.hidden) this.timer = setTimeout(() => { this.timer = undefined; void this.check(); }, 5000);
  }
}
