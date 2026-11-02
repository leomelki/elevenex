import { signal } from '@angular/core';
import type { ElevenexBridge, SavedWaitingTask } from '@elevenex/shared';
import type { WorkspaceWritingJournal } from './workspace-writing-journal';
import type { CreatedTask } from '../tasks';

export interface WaitingTask {
  readonly id: string;
  readonly draft: CreatedTask;
  readonly repoId: number;
  readonly projectId: number;
  readonly planned: boolean;
  readonly status: 'waiting' | 'sending' | 'unknown' | 'failed';
  readonly error?: string;
}

/** Local task drafts have no server identity until accepted. Dispatched creates never replay. */
export class WorkspaceTaskOutbox {
  private readonly records = signal<readonly WaitingTask[]>([]);
  readonly items = this.records.asReadonly();
  private scope: string | null = null;
  private readonly editing = new Map<string, WaitingTask>();
  private working = false;
  private disposed = false;
  constructor(private readonly bridge: Pick<ElevenexBridge, 'workspaceProject' | 'workspaceCreateTask' | 'workspaceSetStage'> & Partial<Pick<ElevenexBridge, 'workspaceTaskRequest'>>,
    private readonly valid: (scope: string) => boolean, private readonly changed: () => Promise<void>, private readonly journal?: WorkspaceWritingJournal | null) {}

  enqueue(item: Omit<WaitingTask, 'status'>): boolean {
    if (this.items().length + this.editing.size >= 10 && !this.editing.has(item.id) || this.items().some(entry => entry.id === item.id)) return false;
    this.editing.delete(item.id);
    this.records.update(items => [...items, { ...item, status: 'waiting' }]); void this.persist(); return true;
  }
  restore(items: readonly SavedWaitingTask[]): void {
    this.editing.clear();
    this.records.set(items.map(item => ({ id: item.id, projectId: item.projectId, repoId: item.input.repoId, planned: item.planned, status: item.status, error: item.error,
      draft: { title: item.input.name, repo: String(item.input.repoId), branch: item.input.branchName, base: item.input.baseRef ?? null, existing: item.input.mode === 'existing', workspace: 'auto' } })));
    if (this.scope) void this.flush(this.scope);
  }
  private persist(): Promise<boolean> {
    return this.journal?.saveTasks([...this.items(), ...this.editing.values()].map(item => ({ id: item.id, projectId: item.projectId, planned: item.planned, status: item.status, ...(item.error ? { error: item.error } : {}),
      input: { requestId: item.id, repoId: item.repoId, name: item.draft.title, branchName: item.draft.branch, mode: item.draft.existing ? 'existing' : 'new', ...(item.draft.base ? { baseRef: item.draft.base } : {}) } }))) ?? Promise.resolve(true);
  }
  async check(scope: string, id: string): Promise<boolean> {
    const item = this.items().find(item => item.id === id && item.status === 'unknown');
    if (!item || !this.current(scope) || !this.bridge.workspaceTaskRequest) return false;
    try {
      const reply = await this.bridge.workspaceTaskRequest(scope, { repoId: item.repoId, requestId: item.id });
      if (!this.current(scope)) return false;
      if (reply.ok && reply.value.task) { this.records.update(items => items.filter(entry => entry.id !== id)); await this.persist(); await this.changed(); return true; }
      else this.update(id, { error: reply.ok ? 'No task has been recorded for this request yet. Nothing is retried automatically. Check again before creating another.' : reply.error.message });
    } catch { if (this.current(scope)) this.update(id, { error: 'Could not check this request. Its outcome is still unknown.' }); }
    return false;
  }
  rememberUnknown(item: Omit<WaitingTask, 'status'>): void { if (this.enqueue(item)) this.update(item.id, { status: 'unknown', error: 'Creation is unconfirmed. Check its recorded request before creating another. Nothing is retried automatically.' }); }
  remove(id: string): void { this.records.update(items => items.filter(item => item.id !== id || item.status === 'sending')); void this.persist(); }
  take(id: string): WaitingTask | undefined {
    const item = this.items().find(item => item.id === id && item.status === 'waiting');
    if (item) {
      this.editing.set(id, item); this.records.update(items => items.filter(entry => entry.id !== id));
      // Keep the original queued request durable while the form owns an unfinished edit.
      // It is not dispatchable again until Save/Cancel returns it to the queue.
      void this.persist();
    }
    return item;
  }
  connect(scope: string | null): void { this.scope = scope; if (scope) void this.flush(scope); }
  clear(): void { this.scope = null; this.records.set([]); this.editing.clear(); }
  dispose(): void { this.disposed = true; this.clear(); }
  private current(scope: string): boolean { return !this.disposed && this.scope === scope && this.valid(scope); }
  private update(id: string, patch: Partial<WaitingTask>, save = true): void { this.records.update(items => items.map(item => item.id === id ? { ...item, ...patch } : item)); if (save) void this.persist(); }
  private async flush(scope: string): Promise<void> {
    if (this.working || !this.current(scope)) return;
    this.working = true;
    try {
      while (this.current(scope)) {
        const candidate = this.items().find(item => item.status === 'waiting');
        if (!candidate) break;
        const detail = await this.bridge.workspaceProject(scope, candidate.projectId);
        if (!this.current(scope)) break;
        const item = this.items().find(entry => entry.id === candidate.id && entry.status === 'waiting');
        if (!item) continue;
        if (detail.ok && detail.value.project.id !== item.projectId) continue;
        if (!detail.ok || !detail.value.repositories.items.some(repo => repo.id === item.repoId)) {
          this.update(item.id, { status: 'failed', error: 'Repository unavailable. Nothing was sent.' }); continue;
        }
        // Claim synchronously before awaiting IPC; cancellation/edit is no longer allowed.
        this.update(item.id, { status: 'sending' }, false);
        if (!await this.persist()) { this.update(item.id, { status: 'failed', error: 'Could not safely save this request. Nothing was sent.' }); break; }
        if (!this.current(scope)) { if (!this.disposed) this.update(item.id, { status: 'waiting' }); break; }
        try {
          const result = await this.bridge.workspaceCreateTask(scope, { repoId: item.repoId, name: item.draft.title, branchName: item.draft.branch,
            mode: item.draft.existing ? 'existing' : 'new', ...(item.draft.base ? { baseRef: item.draft.base } : {}), requestId: item.id });
          if (this.disposed) break;
          if (result.ok) {
            if (item.planned && this.current(scope)) {
              const stage = await this.bridge.workspaceSetStage(scope, { taskId: result.value.id, stage: 'planned' });
              if (!stage.ok) { this.update(item.id, { status: 'failed', error: 'The task was created. Its planned stage could not be confirmed; check the task before changing it.' }); await this.changed(); continue; }
            }
            this.records.update(items => items.filter(entry => entry.id !== item.id)); void this.persist();
            if (this.current(scope)) await this.changed();
          } else this.update(item.id, { status: result.error.code === 'outcome-unknown' || result.error.code === 'stale-scope' ? 'unknown' : 'failed', error: result.error.message });
        } catch { this.update(item.id, { status: 'unknown', error: 'Creation is unconfirmed. Check your tasks before creating another. This request will not be retried.' }); }
      }
    } catch {
      // A failed read leaves undispatched drafts waiting for explicit/transport recovery.
    } finally { this.working = false; }
    if (this.scope && this.scope !== scope && this.current(this.scope)) void this.flush(this.scope);
  }
}
