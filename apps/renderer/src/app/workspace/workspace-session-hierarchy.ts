import { signal } from '@angular/core';
import type { BackendResult, WorkspacePage, WorkspaceSession } from '@elevenex/shared';

interface ChildWindow {
  readonly taskId: number;
  readonly sessions: readonly WorkspaceSession[];
  readonly cursor: string | null;
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly error: string | null;
}

type ReadChildren = (cursor?: string) => Promise<BackendResult<WorkspacePage<WorkspaceSession>>>;
interface ChildRequest {
  readonly background: boolean;
  refresh?: () => void;
}

/** Loaded children follow visible root pages, never an unbounded task snapshot. */
export class WorkspaceSessionHierarchy {
  readonly windows = signal<ReadonlyMap<number, ChildWindow>>(new Map());
  private readonly requests = new Map<number, ChildRequest>();

  reset(): void { this.requests.clear(); this.windows.set(new Map()); }
  retain(roots: readonly WorkspaceSession[]): void {
    const ids = new Set(roots.map(session => session.id));
    for (const id of this.requests.keys()) if (!ids.has(id)) this.requests.delete(id);
    this.windows.update(windows => windows.size === 0 || [...windows.keys()].every(id => ids.has(id))
      ? windows : new Map([...windows].filter(([id]) => ids.has(id))));
  }

  removeSession(sessionId: number): void {
    this.requests.delete(sessionId);
    this.windows.update(windows => {
      const next = new Map(windows);
      next.delete(sessionId);
      for (const [id, window] of next) {
        if (!window.sessions.some(session => session.id === sessionId)) continue;
        this.requests.delete(id);
        next.set(id, { ...window, loading: false, sessions: window.sessions.filter(session => session.id !== sessionId) });
      }
      return next;
    });
  }

  async load(taskId: number, parentId: number, page: 'latest' | 'earlier' | 'refresh', read: ReadChildren, current: () => boolean): Promise<void> {
    if (!current()) return;
    const previous = this.windows().get(parentId);
    const background = page === 'refresh';
    const active = this.requests.get(parentId);
    // Keep the newest invalidation if it arrives during a read. Explicit
    // paging can still supersede a revalidation of the old page.
    if (active && background) {
      active.refresh = () => { void this.load(taskId, parentId, page, read, current); };
      return;
    }
    if (active && !active.background) return;
    const cursor = (background ? previous?.cursor : page === 'earlier' ? previous?.nextCursor : null) ?? null;
    if ((background && !previous) || (page === 'earlier' && !cursor)) return;

    const request: ChildRequest = { background };
    this.requests.set(parentId, request);
    const pending: ChildWindow = { taskId, sessions: previous?.sessions ?? [], cursor: previous?.cursor ?? null, nextCursor: previous?.nextCursor ?? null, loading: true, error: null };
    if (!background) this.set(parentId, pending);
    const ownsRequest = () => this.requests.get(parentId) === request;
    try {
      const result = await read(cursor ?? undefined);
      if (!ownsRequest() || !current()) return;
      if (result.ok) this.set(parentId, { taskId, sessions: result.value.items, cursor, nextCursor: result.value.nextCursor, loading: false, error: null });
      else if (!background) this.set(parentId, { ...pending, loading: false, error: result.error.message });
    } catch {
      if (!background && ownsRequest() && current())
        this.set(parentId, { ...pending, loading: false, error: 'Could not load child sessions. Try again.' });
    } finally {
      if (ownsRequest()) {
        this.requests.delete(parentId);
        // A task-page change can invalidate the reply without unmounting its root.
        if (!background && this.windows().get(parentId) === pending)
          this.set(parentId, { ...pending, loading: false });
        request.refresh?.();
      }
    }
  }

  private set(parentId: number, window: ChildWindow): void {
    this.windows.update(windows => new Map(windows).set(parentId, window));
  }
}
