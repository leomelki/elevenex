import { Injectable, signal } from '@angular/core';
import {
  SESSION_CHAT_TURN_WORK_LIMIT, SESSION_CHAT_TURN_WORK_MAX_LIMIT,
  type SessionChatCompletedTurn, type SessionChatItem, type SessionChatRecord,
} from '@elevenex/shared';
import type { SessionChatClient } from '../backend/session-chat-client.service';
import type { ChatSelection } from './session-chat.store';
import { ChatDisclosureCache } from './session-chat-disclosure-cache';

const CACHE_TURNS = 16;
const CACHE_BYTES = 1536 * 1024;
// Keep the rows mounted until the timeline finishes closing.
const DISCLOSURE_EXIT_MS = 280;

@Injectable({ providedIn: 'root' })
export class SessionChatWorkCache {
  private readonly turns = new ChatDisclosureCache<readonly SessionChatRecord[]>(CACHE_TURNS, CACHE_BYTES);

  private key(selection: ChatSelection, turnId: string, revision: string): string {
    return JSON.stringify([selection.taskId, selection.sessionId, turnId, revision]);
  }

  get(selection: ChatSelection, turnId: string, revision: string): readonly SessionChatRecord[] | undefined {
    return this.turns.get(selection.scopeId, this.key(selection, turnId, revision));
  }

  put(selection: ChatSelection, turnId: string, revision: string, items: readonly SessionChatRecord[]): void {
    this.turns.put(selection.scopeId, this.key(selection, turnId, revision), items);
  }
}

type WorkError = 'failed' | 'changed';
export interface OpenTurnWork {
  readonly revision: string;
  readonly toolIds: readonly string[];
  readonly items?: readonly SessionChatRecord[];
  readonly busy?: true;
  readonly error?: WorkError;
  readonly closing?: true;
}
interface WorkRequest {
  readonly id: string;
  readonly turnId: string;
  readonly revision: string;
  readonly controller: AbortController;
}
interface TurnToolPreparation {
  prepare(items: readonly SessionChatRecord[], toolIds: readonly string[], signal: AbortSignal): Promise<void>;
  afterReveal(release: () => void): void;
}

export function completedTurnRecords(turn: SessionChatCompletedTurn, work?: readonly SessionChatRecord[]): readonly SessionChatRecord[] {
  return work ? [...work.slice(0, turn.beforeReply), ...turn.reply, ...work.slice(turn.beforeReply)] : turn.reply;
}

/** Collect bounded transport replies before publishing any activity to the view. */
export class SessionChatTurnWork {
  readonly open = signal<ReadonlyMap<string, OpenTurnWork>>(new Map());
  private selection: ChatSelection | null = null;
  private available = false;
  private turns = new Map<string, SessionChatCompletedTurn>();
  private readonly pending = new Map<string, WorkRequest>();
  private readonly closing = new Map<string, ReturnType<typeof setTimeout>>();
  private prefetch?: WorkRequest;

  constructor(
    private readonly client: Pick<SessionChatClient, 'turnWork' | 'cancel'>,
    private readonly cache: SessionChatWorkCache,
    private readonly tools?: TurnToolPreparation,
  ) {}

  select(selection: ChatSelection | null, retainDisclosures = false): void {
    this.pause();
    for (const id of this.closing.keys()) this.clearClosing(id);
    this.selection = selection;
    this.turns.clear();
    this.open.update(open => retainDisclosures
      ? new Map([...open].filter(([, turn]) => !turn.closing).map(([id, { revision, toolIds }]) => [id, { revision, toolIds }]))
      : new Map());
  }

  sync(items: readonly SessionChatItem[], available: boolean): void {
    this.turns = new Map(items.flatMap(item => item.completedTurn ? [[item.id, item.completedTurn]] : []));
    if (!available) this.pause();
    this.available = available;
    for (const request of this.pending.values())
      if (this.turns.get(request.turnId)?.revision !== request.revision) this.cancel(request);
    for (const [id, open] of this.open()) {
      const turn = this.turns.get(id);
      if (!turn || (open.closing && turn.revision !== open.revision)) {
        this.clearClosing(id);
        this.set(id, undefined);
      } else if (!open.closing) {
        if (turn.revision !== open.revision) this.set(id, { revision: turn.revision, toolIds: open.toolIds });
        this.load(id);
      }
    }
  }

  pause(): void {
    this.available = false;
    for (const request of this.pending.values()) this.cancel(request);
    for (const [id, open] of this.open())
      if (open.busy) this.set(id, { ...open, busy: undefined });
  }

  toggle(id: string, expanded: boolean, toolIds: readonly string[] = []): void {
    const open = this.open().get(id);
    this.clearClosing(id);
    if (!expanded) {
      const pending = this.pending.get(id);
      if (pending) this.cancel(pending);
      if (!open?.items) this.set(id, undefined);
      else {
        this.set(id, { ...open, closing: true });
        this.closing.set(id, setTimeout(() => {
          this.closing.delete(id);
          this.set(id, undefined);
        }, DISCLOSURE_EXIT_MS));
      }
      return;
    }
    if (open?.closing) {
      this.set(id, { ...open, closing: undefined, toolIds });
      return;
    }
    const revision = this.turns.get(id)?.revision;
    if (!revision || open) return;
    this.set(id, { revision, toolIds });
    this.load(id);
  }

  hint(id: string): void {
    const turn = this.turns.get(id);
    const selection = this.selection;
    if (!turn || !selection || !this.available || this.pending.size || this.open().has(id) ||
      turn.total > SESSION_CHAT_TURN_WORK_LIMIT || this.cache.get(selection, id, turn.revision)) return;
    this.prefetch = this.request(selection, id, turn);
  }

  retry(id: string): void {
    const open = this.open().get(id);
    if (open?.error !== 'failed') return;
    this.set(id, { ...open, error: undefined });
    this.load(id);
  }

  private set(id: string, value: OpenTurnWork | undefined): void {
    this.open.update(open => {
      if (!value && !open.has(id)) return open;
      const next = new Map(open);
      if (value) next.set(id, value);
      else next.delete(id);
      return next;
    });
  }

  private load(id: string): void {
    const selection = this.selection;
    const turn = this.turns.get(id);
    const open = this.open().get(id);
    if (!selection || !turn || !open || open.items || open.closing || open.error) return;
    const cached = this.cache.get(selection, id, turn.revision);
    if (cached && (!open.toolIds.length || !this.tools)) {
      this.set(id, { ...open, items: cached, busy: undefined });
      return;
    }
    if (!this.available && !cached) return;
    if (!open.busy) this.set(id, { ...open, busy: true });
    const active = this.pending.get(id);
    // A click takes ownership of matching speculation. Speculation for a
    // different turn yields to a requested read.
    if (active) {
      if (this.prefetch === active) this.prefetch = undefined;
      return;
    }
    if (this.prefetch) this.cancel(this.prefetch);
    this.request(selection, id, turn, cached);
  }

  private request(selection: ChatSelection, turnId: string, turn: SessionChatCompletedTurn, cached?: readonly SessionChatRecord[]): WorkRequest {
    const request = { id: crypto.randomUUID(), turnId, revision: turn.revision, controller: new AbortController() };
    this.pending.set(turnId, request);
    void this.receive(selection, turn, request, cached);
    return request;
  }

  private async receive(selection: ChatSelection, turn: SessionChatCompletedTurn, request: WorkRequest, cached?: readonly SessionChatRecord[]): Promise<void> {
    const { turnId, revision, controller } = request;
    const result = cached ? { items: cached } : await this.readItems(selection, turn, request);
    if (!result || !this.current(selection, request)) return;
    const open = this.open().get(turnId);
    if ('items' in result) {
      if (!cached) this.cache.put(selection, turnId, revision, result.items);
      if (this.tools && open?.toolIds.length) {
        await this.tools.prepare(result.items, open.toolIds, controller.signal);
        if (!this.current(selection, request)) return;
        // Retain the staged inspections until the mounted tools acquire them,
        // even when their combined evidence exceeds the closed-tool cache.
        this.tools.afterReveal(() => controller.abort());
      }
      if (open) this.set(turnId, { ...open, items: result.items, busy: undefined });
    } else if (open) this.set(turnId, { ...open, error: result.error, busy: undefined });
    this.pending.delete(turnId);
    if (this.prefetch === request) this.prefetch = undefined;
  }

  private async readItems(selection: ChatSelection, turn: SessionChatCompletedTurn, request: WorkRequest):
  Promise<{ items: readonly SessionChatRecord[] } | { error: WorkError } | undefined> {
    const { turnId, revision, id } = request;
    const items: SessionChatRecord[] = [];
    const seen = new Set(turn.reply.map(row => row.id));
    seen.add(turnId);
    while (items.length < turn.total) {
      const offset = items.length;
      const result = await this.client.turnWork(selection.scopeId, {
        taskId: selection.taskId, sessionId: selection.sessionId, turnId, revision, offset,
        requestId: id, deferToolDetails: true, limit: SESSION_CHAT_TURN_WORK_MAX_LIMIT,
      });
      if (!this.current(selection, request)) return;
      if (!result.ok) return { error: result.error.status === 409 ? 'changed' : 'failed' };
      const page = result.value, end = offset + page.items.length;
      if (page.taskId !== selection.taskId || page.sessionId !== selection.sessionId ||
        page.turnId !== turnId || page.revision !== revision || page.offset !== offset || page.total !== turn.total ||
        !page.items.length || end > turn.total || page.nextOffset !== (end < turn.total ? end : null)) return { error: 'failed' };
      for (const row of page.items) {
        if (seen.has(row.id)) return { error: 'failed' };
        seen.add(row.id);
        items.push(row);
      }
    }
    return { items };
  }

  private current(selection: ChatSelection, request: WorkRequest): boolean {
    return this.selection === selection && this.pending.get(request.turnId) === request &&
      this.turns.get(request.turnId)?.revision === request.revision;
  }

  private cancel(request: WorkRequest): void {
    request.controller.abort();
    if (this.selection) this.client.cancel(this.selection.scopeId, request.id);
    this.pending.delete(request.turnId);
    if (this.prefetch === request) this.prefetch = undefined;
  }

  private clearClosing(id: string): void {
    clearTimeout(this.closing.get(id));
    this.closing.delete(id);
  }
}
