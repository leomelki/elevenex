import { signal } from '@angular/core';
import type { ElevenexBridge, SavedWaitingSession } from '@elevenex/shared';
import type { WorkspaceWritingJournal } from './workspace-writing-journal';

/** A new conversation waits for its existing task; it has no invented backend session ID. */
export class WorkspaceSessionOutbox {
  private readonly records = signal<readonly SavedWaitingSession[]>([]);
  readonly items = this.records.asReadonly();
  private scope: string | null = null;
  private working = false;
  private disposed = false;
  constructor(private readonly bridge: Pick<ElevenexBridge, 'workspaceTask' | 'workspaceCreateSession'>,
    private readonly valid: (scope: string) => boolean, private readonly changed: () => Promise<void>, private readonly journal?: WorkspaceWritingJournal | null) {}
  enqueue(taskId: number, taskName: string): boolean {
    if (this.items().length >= 10) return false;
    this.records.update(items => [...items, { id: crypto.randomUUID(), taskId, taskName, status: 'waiting' }]); void this.persist(); return true;
  }
  restore(items: readonly SavedWaitingSession[]): void { this.records.set(items); if (this.scope) void this.flush(this.scope); }
  remove(id: string): void { this.records.update(items => items.filter(item => item.id !== id || item.status === 'sending')); void this.persist(); }
  connect(scope: string | null): void { this.scope = scope; if (scope) void this.flush(scope); }
  clear(): void { this.scope = null; this.records.set([]); }
  dispose(): void { this.disposed = true; this.clear(); }
  private current(scope: string): boolean { return !this.disposed && this.scope === scope && this.valid(scope); }
  private persist(): Promise<boolean> { return this.journal?.saveSessions(this.items()) ?? Promise.resolve(true); }
  private update(id: string, patch: Partial<SavedWaitingSession>): void { this.records.update(items => items.map(item => item.id === id ? { ...item, ...patch } : item)); void this.persist(); }
  private async flush(scope: string): Promise<void> {
    if (this.working || !this.current(scope)) return;
    this.working = true;
    try {
      while (this.current(scope)) {
        const item = this.items().find(item => item.status === 'waiting'); if (!item) break;
        const task = await this.bridge.workspaceTask(scope, item.taskId);
        if (!this.current(scope)) break;
        if (!this.items().some(entry => entry.id === item.id)) continue;
        if (!task.ok || task.value.state !== 'ready' || task.value.archivedAt) { this.update(item.id, { status: 'failed', error: 'The task is no longer ready. Nothing was sent.' }); continue; }
        this.records.update(items => items.map(entry => entry.id === item.id ? { ...entry, status: 'sending' } : entry));
        if (!await this.persist()) { this.update(item.id, { status: 'failed', error: 'Could not save this request safely. Nothing was sent.' }); break; }
        if (!this.current(scope)) { if (!this.disposed) this.update(item.id, { status: 'waiting' }); break; }
        const reply = await this.bridge.workspaceCreateSession(scope, { taskId: item.taskId });
        if (this.disposed) break;
        if (reply.ok) { this.records.update(items => items.filter(entry => entry.id !== item.id)); void this.persist(); if (this.current(scope)) await this.changed(); }
        else this.update(item.id, { status: reply.error.code === 'outcome-unknown' || reply.error.code === 'stale-scope' ? 'unknown' : 'failed', error: 'Session creation is unconfirmed. Inspect this task before creating another. Nothing will be retried automatically.' });
      }
    } catch { const item = this.items().find(item => item.status === 'sending'); if (item) this.update(item.id, { status: 'unknown', error: 'Creation is unconfirmed. Inspect this task before creating another.' }); }
    finally { this.working = false; }
    if (this.scope && this.scope !== scope && this.current(this.scope)) void this.flush(this.scope);
  }
}
