import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type { TaskBrowserCommand, TaskBrowserState, TaskBrowserPlacement } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';

/** Task selection, bounded state and stale-reply rejection. Conversation selection never resets tabs. */
@Injectable()
export class TaskBrowserStore {
  readonly bridge = inject(ELEVENEX_BRIDGE);
  readonly state = signal<TaskBrowserState | null>(null);
  readonly error = signal('');
  readonly pending = signal(0);
  readonly tabsPending = signal(0);
  readonly current = computed(() => this.state()?.tabs.find(tab => tab.id === this.state()?.active));
  private selection: { scopeId: string; taskId: number } | null = null;
  private epoch = 0;
  private disposed = false;
  constructor() {
    const stop = this.bridge.onTaskBrowserChanged?.(state => this.accept(state));
    inject(DestroyRef).onDestroy(() => { this.disposed = true; this.epoch++; stop?.(); if (this.selection) void this.bridge.taskBrowserDeactivate?.(this.selection.scopeId, this.selection.taskId); if (this.selection) void this.bridge.taskBrowserHide?.(this.selection.scopeId, this.selection.taskId); });
  }
  open(scopeId: string | null, taskId: number | null): void {
    if (this.selection?.scopeId === scopeId && this.selection?.taskId === taskId) return;
    if (this.selection) void this.bridge.taskBrowserDeactivate?.(this.selection.scopeId, this.selection.taskId);
    this.epoch++; this.selection = scopeId && taskId ? { scopeId, taskId } : null;
    this.pending.set(0); this.tabsPending.set(0);
    this.state.set(null); this.error.set(''); if (this.selection) void this.bridge.taskBrowserHide?.(this.selection.scopeId, this.selection.taskId);
    if (this.selection) void this.read();
  }
  async read(): Promise<void> {
    const selected = this.selection, epoch = this.epoch;
    if (!selected || this.disposed) return;
    if (!this.bridge.taskBrowserRead) { this.error.set('This desktop does not support task browsing.'); return; }
    this.pending.update(n => n + 1);
    try {
      const reply = await this.bridge.taskBrowserRead(selected.scopeId, selected.taskId);
      if (!this.valid(epoch)) return;
      if (reply.ok) this.accept(reply.value); else this.error.set(reply.error.message);
    } catch { if (this.valid(epoch)) this.error.set('The browser connection failed. Refresh to reconnect.'); }
    finally { if (this.valid(epoch)) this.pending.update(n => Math.max(0, n - 1)); }
  }
  async command(input: TaskBrowserCommand): Promise<boolean> {
    const selected = this.selection, epoch = this.epoch;
    if (!selected || this.disposed) return false;
    const changesTabs = input.kind === 'new-tab' || input.kind === 'open' || input.kind === 'close' || input.kind === 'move-tab';
    if (changesTabs) this.tabsPending.update(n => n + 1);
    this.error.set(''); this.pending.update(n => n + 1);
    try {
      const reply = await this.bridge.taskBrowserCommand(selected.scopeId, selected.taskId, input);
      if (!this.valid(epoch)) return false;
      if (reply.ok) { this.accept(reply.value); return true; }
      this.error.set(reply.error.message); return false;
    } catch { if (this.valid(epoch)) this.error.set('Browser action interrupted. Inspect the page before trying again.'); return false; }
    finally {
      if (this.valid(epoch)) {
        this.pending.update(n => Math.max(0, n - 1));
        if (changesTabs) this.tabsPending.update(n => Math.max(0, n - 1));
      }
    }
  }
  async configure(placement: TaskBrowserPlacement): Promise<void> {
    const selected = this.selection, epoch = this.epoch;
    if (!selected || !this.bridge.taskBrowserConfigure || this.disposed || this.pending()) return;
    this.error.set(''); this.pending.update(n => n + 1);
    try {
      const reply = await this.bridge.taskBrowserConfigure(selected.scopeId, selected.taskId, placement);
      if (!this.valid(epoch)) return;
      if (reply.ok && reply.value.scopeId === selected.scopeId && reply.value.taskId === selected.taskId) {
        // A replacement engine starts a new task-state revision domain.
        this.state.set(reply.value);
      } else if (!reply.ok) this.error.set(reply.error.message);
    } catch { if (this.valid(epoch)) this.error.set('Could not change browser placement. Refresh to reconcile.'); }
    finally { if (this.valid(epoch)) this.pending.update(n => Math.max(0, n - 1)); }
  }
  private valid(epoch: number): boolean { return !this.disposed && epoch === this.epoch; }
  private accept(state: TaskBrowserState): void {
    if (this.disposed || state.scopeId !== this.selection?.scopeId || state.taskId !== this.selection.taskId || state.revision < (this.state()?.revision ?? -1)) return;
    this.state.set(state);
  }
}
