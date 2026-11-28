import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import type { EnvironmentSelection, SavedWaitingChat, SavedWaitingSession, SavedWaitingTask, WaitingWriting, WaitingWritingSnapshot } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';

/** Main-owned durable journal, scoped to this window and exact configured machine. */
@Injectable()
export class WorkspaceWritingJournal {
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  readonly restored = signal<WaitingWritingSnapshot | null>(null);
  readonly error = signal('');
  private environment: EnvironmentSelection | null = null;
  private identity = '';
  private value: WaitingWriting = { chat: [], tasks: [] };
  private epoch = 0;
  private disposed = false;
  private writeRevision = 0;
  constructor() { inject(DestroyRef).onDestroy(() => { this.disposed = true; this.epoch++; }); }
  async open(environment: EnvironmentSelection): Promise<void> {
    const epoch = ++this.epoch;
    this.environment = environment; this.restored.set(null); this.error.set('');
    // Preview/test adapters without journaling retain explicit window-only storage.
    if (!this.bridge.workspaceWaitingRead) { this.restored.set({ identity: '', chat: [], tasks: [] }); return; }
    try {
      const saved = await this.bridge.workspaceWaitingRead(environment);
      if (this.disposed || epoch !== this.epoch) return;
      const interrupted = <T extends { readonly status: string; readonly error?: string }>(item: T): T => item.status === 'sending'
        ? { ...item, status: 'unknown', error: 'This action was in progress when the window closed. Check its outcome before sending again. Nothing will be retried.' } : item;
      this.identity = saved.identity; this.value = { chat: saved.chat.map(interrupted), tasks: saved.tasks.map(interrupted), ...(saved.sessions ? { sessions: saved.sessions.map(interrupted) } : {}) };
      this.restored.set({ ...this.value, identity: saved.identity });
    } catch { if (!this.disposed && epoch === this.epoch) this.error.set('Waiting writing could not be restored. Reopen this machine to try again.'); }
  }
  async retry(): Promise<void> { if (!this.environment) return; if (!this.restored()) await this.open(this.environment); else await this.save(); }
  saveChat(chat: readonly SavedWaitingChat[]): Promise<boolean> { this.value = { ...this.value, chat }; return this.save(); }
  saveTasks(tasks: readonly SavedWaitingTask[]): Promise<boolean> { this.value = { ...this.value, tasks }; return this.save(); }
  saveSessions(sessions: readonly SavedWaitingSession[]): Promise<boolean> { this.value = { ...this.value, sessions }; return this.save(); }
  private async save(): Promise<boolean> {
    const environment = this.environment, value = this.value, identity = this.identity, epoch = this.epoch;
    if (this.disposed || !environment || !this.restored()) return false;
    if (!this.bridge.workspaceWaitingSave) return true;
    const revision = ++this.writeRevision;
    // Dispatch immediately: closing the window must not strand its newest edit or
    // cancellation in a renderer timer. Main coalesces atomic writes to one active
    // and one latest pending snapshot, shared with its existing settings owner.
    try {
      await this.bridge.workspaceWaitingSave(environment, identity, value);
      if (epoch === this.epoch && !this.disposed && revision === this.writeRevision) this.error.set('');
      return true;
    } catch { if (epoch === this.epoch && !this.disposed && revision === this.writeRevision) this.error.set('Waiting writing could not be saved. Keep this window open and try again. '); return false; }
  }
}
