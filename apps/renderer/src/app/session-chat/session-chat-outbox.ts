import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import type { SavedWaitingChat, SessionChatAction, SessionChatState } from '@elevenex/shared';
import { BackendClientService } from '../backend/backend-client.service';
import { SessionChatClient } from '../backend/session-chat-client.service';
import { WorkspaceWritingJournal } from '../workspace/workspace-writing-journal';
import type { ChatSelection } from './session-chat.store';

export interface WaitingChatAction {
  readonly id: string;
  readonly target: ChatSelection;
  readonly action: SessionChatAction;
  readonly label: string;
  readonly turnId: string | null;
  readonly status: 'waiting' | 'sending' | 'unknown' | 'failed';
  readonly error?: string;
}

/** Workspace-owned outbox with a main-process durable journal. Only never-dispatched actions can leave waiting. */
@Injectable()
export class SessionChatOutbox {
  private readonly journal = inject(WorkspaceWritingJournal, { optional: true });
  readonly restoring = computed(() => !!this.journal && !this.journal.restored());
  private readonly client = inject(SessionChatClient);
  private readonly backend = inject(BackendClientService);
  private readonly records = signal<readonly WaitingChatAction[]>([]);
  private readonly scope = signal<string | null>(null);
  private readonly editing = signal<string | null>(null);
  setEditing(id: string | null): void { this.editing.set(id); }
  private working = false;
  private disposed = false;
  private readonly receipts = new Map<string, { readonly users: ReadonlySet<string>; readonly queue: ReadonlySet<string> }>();
  private pendingRead: { scope: string; id: string } | null = null;
  readonly items = this.records.asReadonly();
  readonly count = computed(() => this.items().filter(item => item.status === 'waiting').length);

  constructor() {
    effect(() => {
      const saved = this.journal?.restored();
      if (saved) this.records.set(saved.chat.map(item => ({ ...item, target: { taskId: item.taskId, sessionId: item.sessionId, scopeId: '' } })));
    });
    effect(() => {
      this.records(); this.editing();
      const scope = this.scope();
      const ready = this.backend.state().scope?.id === scope;
      if (scope && ready) void this.flush(scope);
    });
    inject(DestroyRef).onDestroy(() => { this.disposed = true; if (this.pendingRead) this.client.cancel(this.pendingRead.scope, this.pendingRead.id); });
  }
  /** Called only after the workspace reconciles its environment and durable resources. */
  connect(scope: string | null): void { if (scope !== this.scope() && this.pendingRead) this.client.cancel(this.pendingRead.scope, this.pendingRead.id); this.scope.set(scope); }
  enqueue(target: ChatSelection, action: SessionChatAction, label: string, turnId: string | null): boolean {
    if (this.items().length >= 20 || JSON.stringify(action).length > 128_000 || this.items().reduce((size, item) => size + JSON.stringify(item.action).length, JSON.stringify(action).length) > 512_000) return false;
    if (!['send', 'stop', 'answer', 'permission'].includes(action.type)) return false;
    if (this.restoring()) return false;
    this.records.update(items => [...items, { id: 'waiting-' + crypto.randomUUID(), target, action, label, turnId, status: 'waiting' }]);
    void this.persist();
    return true;
  }
  clear(): void { this.scope.set(null); this.records.set([]); this.receipts.clear(); this.editing.set(null); }
  remove(id: string): void { if (this.items().some(item => item.id === id && item.status !== 'sending')) { this.records.update(items => items.filter(item => item.id !== id)); this.receipts.delete(id); void this.persist(); } }
  edit(id: string, text: string): void {
    if (!text.trim() || text.length > 64000) return;
    this.records.update(items => items.map(item => item.id === id && item.status === 'waiting' && item.action.type === 'send'
      ? { ...item, label: text.trim(), action: { ...item.action, text: text.trim() } } : item));
    void this.persist();
  }
  async check(id: string): Promise<void> {
    const item = this.items().find(item => item.id === id && item.status === 'unknown'), scope = this.scope(), receipt = this.receipts.get(id);
    if (!item || item.action.type !== 'send' || !scope || !this.current(scope)) return;
    if (!receipt) { this.update(id, { error: 'This send was interrupted before relaunch. Inspect the conversation, then acknowledge its outcome here. Nothing is retried.' }); return; }
    const text = item.action.text;
    const result = await this.client.read(scope, { taskId: item.target.taskId, sessionId: item.target.sessionId, requestId: crypto.randomUUID() });
    if (!this.current(scope) || !this.items().some(item => item.id === id)) return;
    if (result.ok && (result.value.items.some(entry => entry.kind === 'user' && !receipt.users.has(entry.id) && entry.text === text)
      || result.value.state.queue.some(entry => !receipt.queue.has(entry.id) && entry.text === text))) this.remove(id);
    else this.update(id, { error: 'Delivery is still unconfirmed in the latest conversation window. Inspect the conversation before sending again. Nothing was retried.' });
  }
  private persist(): Promise<boolean> {
    const chat: SavedWaitingChat[] = this.items().map(item => {
      const action = item.action;
      if (action.type !== 'send' && action.type !== 'stop' && action.type !== 'answer' && action.type !== 'permission') throw new Error('Unsupported waiting action.');
      return { id: item.id, taskId: item.target.taskId, sessionId: item.target.sessionId, action, label: item.label, turnId: item.turnId, status: item.status, ...(item.error ? { error: item.error } : {}) };
    });
    return this.journal?.saveChat(chat) ?? Promise.resolve(true);
  }
  private update(id: string, patch: Partial<WaitingChatAction>, save = true): void {
    this.records.update(items => items.map(item => item.id === id ? { ...item, ...patch } : item));
    if (save) void this.persist();
  }
  private current(scope: string): boolean { return !this.disposed && this.scope() === scope && this.backend.state().scope?.id === scope; }
  private async flush(scope: string): Promise<void> {
    if (this.working || !this.current(scope)) return;
    this.working = true;
    try {
      while (this.current(scope)) {
        const item = this.items().find(item => item.status === 'waiting' && !this.items().some(other => other.target.sessionId === item.target.sessionId && (other.status === 'unknown' || other.status === 'sending')));
        if (!item || this.editing() === item.id) break;
        const requestId = crypto.randomUUID();
        this.pendingRead = { scope, id: requestId };
        const read = this.client.read(scope, { taskId: item.target.taskId, sessionId: item.target.sessionId, requestId });
        // Cancels the membership/state read if this owner disappears or loses its scope.
        const page = await read;
        this.pendingRead = null;
        if (!this.current(scope)) { this.client.cancel(scope, requestId); break; }
        if (!this.items().some(entry => entry.id === item.id && entry.status === 'waiting')) continue;
        if (!page.ok) { this.update(item.id, { status: 'failed', error: 'Could not check this conversation. Nothing was sent. Remove it or keep it for inspection.' }); continue; }
        if (this.editing() === item.id) continue;
        const latest = this.items().find(entry => entry.id === item.id)!;
        if (!this.applicable(latest, page.value.state, [...page.value.items].reverse().find(entry => entry.kind === 'user')?.id ?? null)) {
          this.update(item.id, { status: 'failed', error: 'The request changed while disconnected. Nothing was sent. Review the conversation.' }); continue;
        }
        this.receipts.set(item.id, { users: new Set(page.value.items.map(item => item.id)), queue: new Set(page.value.state.queue.map(item => item.id)) });
        this.update(item.id, { status: 'sending' }, false);
        if (!await this.persist()) { this.update(item.id, { status: 'failed', error: 'Waiting writing could not be saved safely. Nothing was sent.' }); break; }
        if (!this.current(scope)) { if (!this.disposed) this.update(item.id, { status: 'waiting' }); break; }
        const action = latest.action.type === 'send' ? { ...latest.action, queue: page.value.state.queuePaused || page.value.state.phase === 'running' || page.value.state.phase === 'waiting' } : latest.action;
        const reply = await this.client.command(scope, { taskId: latest.target.taskId, sessionId: latest.target.sessionId, action });
        if (this.disposed) break;
        if (reply.ok) this.removeSent(item.id);
        else this.update(item.id, { status: reply.error.code === 'outcome-unknown' || reply.error.code === 'stale-scope' ? 'unknown' : 'failed', error: reply.error.code === 'outcome-unknown' || reply.error.code === 'stale-scope'
          ? 'Delivery is unconfirmed. Check the conversation before sending again. This action will not be retried.' : reply.error.message });
      }
    } finally { this.working = false; }
    // A replacement scope may have arrived while the old command settled.
    const next = this.scope();
    if (next && next !== scope && this.current(next)) void this.flush(next);
  }
  private removeSent(id: string): void { this.records.update(items => items.filter(item => item.id !== id)); this.receipts.delete(id); void this.persist(); }
  private applicable(item: WaitingChatAction, state: SessionChatState, turnId: string | null): boolean {
    if (item.action.type === 'permission') return state.permission?.id === item.action.id;
    if (item.action.type === 'answer') return state.question?.id === item.action.id;
    if (item.action.type === 'stop') return item.turnId !== null && !!state.canInterrupt && item.turnId === turnId;
    return true;
  }
}
