import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { isSessionChatDeliveryId } from '@elevenex/shared';
import type { SavedWaitingChat, SessionChatAction, SessionChatState } from '@elevenex/shared';
import { BackendClientService } from '../backend/backend-client.service';
import { SessionChatClient } from '../backend/session-chat-client.service';
import { WorkspaceWritingJournal } from '../workspace/workspace-writing-journal';
import { ambiguousChatDelivery, checkChatDelivery } from './session-chat-delivery';
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
  private readonly checks = new Map<string, AbortController>();
  private readonly checked = new Set<string>();
  private readonly enginePending = new Set<string>();
  private checkingScope: string | null = null;
  private readonly activeChecks = signal<ReadonlySet<string>>(new Set());
  readonly checking = this.activeChecks.asReadonly();
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
    effect(() => {
      const scope = this.scope();
      const connected = scope && this.backend.state().scope?.id === scope ? scope : null;
      const unknown = this.records().filter(item => item.status === 'unknown' && item.action.type === 'send');
      untracked(() => this.syncChecks(connected, unknown));
    });
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true;
      if (this.pendingRead) this.client.cancel(this.pendingRead.scope, this.pendingRead.id);
      this.syncChecks(null, []);
    });
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
  clear(): void { this.scope.set(null); this.records.set([]); this.syncChecks(null, []); this.editing.set(null); }
  remove(id: string): void { if (this.items().some(item => item.id === id && item.status !== 'sending')) { this.records.update(items => items.filter(item => item.id !== id)); void this.persist(); } }
  edit(id: string, text: string): void {
    if (!text.trim() || text.length > 64000) return;
    this.records.update(items => items.map(item => item.id === id && item.status === 'waiting' && item.action.type === 'send'
      ? { ...item, label: text.trim(), action: { ...item.action, text: text.trim() } } : item));
    void this.persist();
  }
  retryRejected(id: string): void {
    this.records.update(items => items.map(item => item.id === id && item.status === 'failed' && item.action.type === 'send'
      ? { ...item, id: 'waiting-' + crypto.randomUUID(), status: 'waiting', error: undefined } : item));
    void this.persist();
  }

  receiptChanged(target: ChatSelection, deliveryId: string): void {
    const id = 'waiting-' + deliveryId;
    if (!this.current(target.scopeId)) return;
    const item = this.items().find(entry => entry.id === id && entry.status === 'unknown' &&
      entry.target.taskId === target.taskId && entry.target.sessionId === target.sessionId);
    if (!item) return;
    this.checks.get(id)?.abort();
    void this.checkSend(target.scopeId, item);
  }

  private syncChecks(scope: string | null, items: readonly WaitingChatAction[]): void {
    if (scope !== this.checkingScope) {
      for (const check of this.checks.values()) check.abort();
      this.checks.clear();
      this.checked.clear();
      this.enginePending.clear();
      this.activeChecks.set(new Set());
      this.checkingScope = scope;
    }
    const ids = new Set(items.map(item => item.id));
    for (const id of this.checked) {
      if (ids.has(id)) continue;
      this.checks.get(id)?.abort();
      this.checks.delete(id);
      this.checked.delete(id);
      this.enginePending.delete(id);
    }
    this.activeChecks.set(new Set([...this.checks.keys(), ...this.enginePending]));
    if (scope) for (const item of items) {
      if (!this.checked.has(item.id)) void this.checkSend(scope, item);
    }
  }

  private async checkSend(scope: string, item: WaitingChatAction): Promise<void> {
    const deliveryId = item.id.startsWith('waiting-') ? item.id.slice('waiting-'.length) : undefined;
    this.checked.add(item.id);
    if (!isSessionChatDeliveryId(deliveryId)) return;
    const abort = new AbortController();
    this.checks.set(item.id, abort);
    this.activeChecks.set(new Set([...this.checks.keys(), ...this.enginePending]));
    const result = await checkChatDelivery(this.client, scope, item.target, deliveryId, abort.signal, [0, 500, 1500, 4000, 12000]);
    if (this.checks.get(item.id) !== abort) return;
    this.checks.delete(item.id);
    if (result === 'pending') this.enginePending.add(item.id);
    else this.enginePending.delete(item.id);
    this.activeChecks.set(new Set([...this.checks.keys(), ...this.enginePending]));
    if (abort.signal.aborted || !this.current(scope) || !this.items().some(entry => entry.id === item.id && entry.status === 'unknown')) return;
    if (result === 'accepted') this.remove(item.id);
    if (result === 'failed') this.update(item.id, { status: 'failed', error: 'The message was rejected.' });
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
        const item = this.items().find(item => item.status === 'waiting' && !this.items().some(other => other.target.sessionId === item.target.sessionId && ((other.status === 'unknown' && other.action.type !== 'send') || other.status === 'sending')));
        if (!item || this.editing() === item.id) break;
        const requestId = crypto.randomUUID();
        this.pendingRead = { scope, id: requestId };
        const read = this.client.read(scope, { taskId: item.target.taskId, sessionId: item.target.sessionId, requestId });
        // Cancels the membership/state read if this owner disappears or loses its scope.
        const page = await read;
        this.pendingRead = null;
        if (!this.current(scope)) { this.client.cancel(scope, requestId); break; }
        if (!this.items().some(entry => entry.id === item.id && entry.status === 'waiting')) continue;
        if (!page.ok) { this.update(item.id, { status: 'failed', error: 'Could not reach this conversation. The queued action was not sent.' }); continue; }
        if (this.editing() === item.id) continue;
        const latest = this.items().find(entry => entry.id === item.id)!;
        if (!this.applicable(latest, page.value.state, [...page.value.items].reverse().find(entry => entry.kind === 'user')?.id ?? null)) {
          this.update(item.id, { status: 'failed', error: 'The request changed while disconnected. Nothing was sent. Review the conversation.' }); continue;
        }
        this.update(item.id, { status: 'sending' }, false);
        if (!await this.persist()) { this.update(item.id, { status: 'failed', error: 'Waiting writing could not be saved safely. Nothing was sent.' }); break; }
        if (!this.current(scope)) { if (!this.disposed) this.update(item.id, { status: 'waiting' }); break; }
        const action = latest.action.type === 'send' ? { ...latest.action, queue: page.value.state.queuePaused || page.value.state.phase === 'running' || page.value.state.phase === 'waiting' } : latest.action;
        const deliveryId = latest.id.startsWith('waiting-') ? latest.id.slice('waiting-'.length) : undefined;
        const reply = await this.client.command(scope, {
          taskId: latest.target.taskId, sessionId: latest.target.sessionId, action,
          ...(action.type === 'send' && isSessionChatDeliveryId(deliveryId) ? { deliveryId } : {}),
        });
        if (this.disposed) break;
        if (reply.ok) this.removeSent(item.id);
        else {
          const unknown = ambiguousChatDelivery(reply.error);
          this.update(item.id, {
            status: unknown ? 'unknown' : 'failed',
            error: unknown ? 'The earlier action may have reached the agent.' : reply.error.message,
          });
        }
      }
    } finally { this.working = false; }
    // A replacement scope may have arrived while the old command settled.
    const next = this.scope();
    if (next && next !== scope && this.current(next)) void this.flush(next);
  }
  private removeSent(id: string): void { this.records.update(items => items.filter(item => item.id !== id)); void this.persist(); }
  private applicable(item: WaitingChatAction, state: SessionChatState, turnId: string | null): boolean {
    if (item.action.type === 'permission') return state.permission?.id === item.action.id;
    if (item.action.type === 'answer') return state.question?.id === item.action.id;
    if (item.action.type === 'stop') return item.turnId !== null && !!state.canInterrupt && item.turnId === turnId;
    return true;
  }
}
