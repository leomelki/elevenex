import { signal } from '@angular/core';
import type { BackendResult, WorkspacePage, WorkspaceSession } from '@elevenex/shared';

interface ChildWindow {
  readonly taskId: number;
  readonly sessions: readonly WorkspaceSession[];
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly earlier: boolean;
  readonly error: string | null;
}

/** Loaded children follow visible root pages, never an unbounded task snapshot. */
export class WorkspaceSessionHierarchy {
  readonly windows = signal<ReadonlyMap<number, ChildWindow>>(new Map());
  private generation = 0;
  reset(): void { this.generation++; this.windows.set(new Map()); }
  retain(roots: readonly WorkspaceSession[]): void {
    const ids = new Set(roots.map(session => session.id));
    this.windows.update(windows => new Map([...windows].filter(([id]) => ids.has(id))));
  }
  removeSession(sessionId: number): void {
    this.windows.update(windows => new Map([...windows].filter(([id]) => id !== sessionId).map(([id, window]) => [id, window.sessions.some(session => session.id === sessionId) ? { ...window, loading: false, sessions: window.sessions.filter(session => session.id !== sessionId) } : window])));
  }
  async load(taskId: number, parentId: number, earlier: boolean, read: (cursor?: string) => Promise<BackendResult<WorkspacePage<WorkspaceSession>>>, current: () => boolean): Promise<void> {
    const previous = this.windows().get(parentId), generation = this.generation;
    if (previous?.loading || (earlier && !previous?.nextCursor)) return;
    const pending = { taskId, sessions: previous?.sessions ?? [], nextCursor: previous?.nextCursor ?? null, earlier: previous?.earlier ?? false, loading: true, error: null };
    this.windows.update(windows => new Map(windows).set(parentId, pending));
    try {
      const result = await read(earlier ? previous?.nextCursor ?? undefined : undefined);
      if (!current() || generation !== this.generation || this.windows().get(parentId) !== pending) return;
      this.windows.update(windows => new Map(windows).set(parentId, result.ok
        ? { taskId, sessions: result.value.items, nextCursor: result.value.nextCursor, earlier, loading: false, error: null }
        : { ...pending, loading: false, error: result.error.message }));
    } catch {
      if (current() && generation === this.generation && this.windows().get(parentId) === pending)
        this.windows.update(windows => new Map(windows).set(parentId, { ...pending, loading: false, error: 'Could not load child sessions. Try again.' }));
    } finally {
      // A task-page change can invalidate the reply without unmounting its root.
      if (generation === this.generation && this.windows().get(parentId) === pending)
        this.windows.update(windows => new Map(windows).set(parentId, { ...pending, loading: false }));
    }
  }
}
