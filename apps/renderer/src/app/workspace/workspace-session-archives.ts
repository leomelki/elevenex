import { signal } from '@angular/core';
import type { ElevenexBridge, WorkspacePage, WorkspaceSession } from '@elevenex/shared';

interface ArchivePage {
  readonly sessions: readonly WorkspaceSession[];
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly cursor: string | null;
  readonly nextCursor: string | null;
}

/** Independent bounded history windows. The workspace owns scope and task lifetime. */
export class WorkspaceSessionArchives {
  readonly pages = signal<ReadonlyMap<number, ArchivePage>>(new Map());
  private readonly requests = new Map<number, { readonly settled: Promise<void>; readonly finish: () => void }>();
  private tasks = new Set<number>();
  private generation = 0;

  constructor(
    private readonly bridge: Pick<ElevenexBridge, 'workspaceSessions'>,
    private readonly valid: (scope: string) => boolean,
  ) {}

  retain(taskIds: readonly number[]): void {
    this.tasks = new Set(taskIds);
    this.pages.update(pages => new Map([...pages].filter(([id]) => this.tasks.has(id))));
    for (const id of this.requests.keys()) if (!this.tasks.has(id)) this.requests.delete(id);
  }

  /** Adopt a reconciled window only while this scope still owns the task. */
  acceptRestoredWindow(scope: string, taskId: number, page: WorkspacePage<WorkspaceSession>, cursor?: string): void {
    if (!this.valid(scope) || !this.tasks.has(taskId)) return;
    // Any read started before reconciliation must not replace the restored page.
    this.requests.delete(taskId);
    this.set(taskId, { sessions: page.items, cursor: cursor ?? null, nextCursor: page.nextCursor, loaded: true, loading: false, error: null });
  }

  async load(scope: string, taskId: number, page: 'latest' | 'earlier' | 'refresh' | 'probe' = 'latest'): Promise<void> {
    if (!this.valid(scope) || !this.tasks.has(taskId) || this.requests.has(taskId)) return;
    const previous = this.pages().get(taskId);
    const cursor = page === 'earlier' ? previous?.nextCursor : page === 'refresh' ? previous?.cursor : null;
    if (page === 'earlier' && !cursor) return;
    let finish!: () => void;
    const settled = new Promise<void>(resolve => { finish = resolve; });
    const generation = this.generation, request = { settled, finish };
    this.requests.set(taskId, request);
    const current = () => generation === this.generation && this.valid(scope) && this.requests.get(taskId) === request;
    const loading: ArchivePage = { sessions: previous?.sessions ?? [], loaded: previous?.loaded ?? false, loading: true, error: null, cursor: previous?.cursor ?? null, nextCursor: previous?.nextCursor ?? null };
    this.set(taskId, loading);
    let emptyEarlierPage = false;
    try {
      const result = await this.bridge.workspaceSessions(scope, { taskId, state: 'archived', order: 'latest', limit: page === 'probe' ? 1 : 20, ...(cursor ? { cursor } : {}) });
      if (!current()) return;
      if (result.ok) {
        this.set(taskId, { sessions: result.value.items, loaded: page !== 'probe' || !result.value.items.length, loading: false, error: null, cursor: cursor ?? null, nextCursor: result.value.nextCursor });
        emptyEarlierPage = !!cursor && !result.value.items.length;
      } else this.set(taskId, { ...loading, loading: false, error: result.error.message });
    } catch {
      if (current()) this.set(taskId, { ...loading, loading: false, error: 'Archived sessions could not be loaded. Try again.' });
    } finally {
      if (this.requests.get(taskId) === request) this.requests.delete(taskId);
      request.finish();
    }
    // An empty older window does not establish whether any archives remain.
    if (emptyEarlierPage && generation === this.generation && this.valid(scope)) await this.load(scope, taskId);
  }

  async refresh(scope: string, taskId: number): Promise<void> {
    const page = this.pages().get(taskId);
    await this.load(scope, taskId, page?.loaded && (page.sessions.length || page.cursor) ? 'refresh' : 'probe');
  }

  /** Invalidate reads started before a successful mutation, then reconcile history. */
  async changed(scope: string, taskId: number, restoredId?: number): Promise<void> {
    if (!this.valid(scope)) return;
    const pending = this.requests.get(taskId);
    this.requests.delete(taskId);
    const page = this.pages().get(taskId);
    if (page && restoredId !== undefined) this.set(taskId, { ...page, sessions: page.sessions.filter(session => session.id !== restoredId) });
    // Main coalesces identical reads: let the pre-mutation request settle before re-reading.
    if (pending) await pending.settled;
    if (this.valid(scope) && this.pages().has(taskId)) {
      const current = this.pages().get(taskId);
      await this.load(scope, taskId, current?.loaded && current.sessions.length ? 'latest' : 'probe');
    }
  }

  reset(): void {
    this.generation++;
    this.requests.clear(); this.tasks.clear(); this.pages.set(new Map());
  }

  private set(taskId: number, page: ArchivePage): void {
    this.pages.update(pages => new Map(pages).set(taskId, page));
  }
}
