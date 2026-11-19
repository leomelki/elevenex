import { Injectable, signal } from '@angular/core';
import { SESSION_CHAT_TURN_WORK_LIMIT, type SessionChatCompletedTurn, type SessionChatItem, type SessionChatTurnWorkPage } from '@elevenex/shared';
import type { SessionChatClient } from '../backend/session-chat-client.service';
import type { ChatSelection } from './session-chat.store';
import { ChatDisclosureCache } from './session-chat-disclosure-cache';

const CACHE_PAGES = 16;
const CACHE_BYTES = 1536 * 1024;
// Retain the last page through the timeline's Fold exit.
const DISCLOSURE_EXIT_MS = 280;

/** Window-local LRU. Closing a turn releases its view data and retains only bounded pages. */
@Injectable({ providedIn: 'root' })
export class SessionChatWorkCache {
  private readonly pages = new ChatDisclosureCache<SessionChatTurnWorkPage>(CACHE_PAGES, CACHE_BYTES);

  private key(selection: ChatSelection, turnId: string, revision: string, offset: number): string {
    return JSON.stringify([selection.taskId, selection.sessionId, turnId, revision, offset]);
  }

  get(selection: ChatSelection, turnId: string, revision: string, offset: number): SessionChatTurnWorkPage | undefined {
    return this.pages.get(selection.scopeId, this.key(selection, turnId, revision, offset));
  }

  put(selection: ChatSelection, page: SessionChatTurnWorkPage): void {
    this.pages.put(selection.scopeId, this.key(selection, page.turnId, page.revision, page.offset), page);
  }
}

interface WorkPosition {
  readonly offset: number;
  readonly previous: readonly number[];
}
export interface OpenTurnWork {
  readonly revision: string;
  readonly page?: SessionChatTurnWorkPage;
  readonly previous: readonly number[];
  readonly requested?: WorkPosition;
  readonly error?: 'unavailable' | 'failed' | 'changed';
  readonly closing?: true;
}
interface WorkRequest {
  readonly id: string;
  readonly turnId: string;
  readonly offset: number;
  readonly revision: string;
}
const firstPage: WorkPosition = { offset: 0, previous: [] };

/** One conversation owns disclosure requests independently of its history cursor. */
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
  ) {}

  select(selection: ChatSelection | null, retainDisclosures = false): void {
    this.pause();
    for (const id of this.closing.keys()) this.clearClosing(id);
    this.selection = selection;
    this.turns.clear();
    if (retainDisclosures) {
      this.open.update(open => new Map([...open].filter(([, turn]) => !turn.closing).map(([id, turn]) =>
        [id, { revision: turn.revision, previous: [] }])));
    } else this.open.set(new Map());
  }

  sync(items: readonly SessionChatItem[], available: boolean): void {
    this.turns = new Map(items.flatMap(item => item.completedTurn ? [[item.id, item.completedTurn]] : []));
    if (!available) this.pause();
    this.available = available;
    for (const request of this.pending.values()) {
      if (this.turns.get(request.turnId)?.revision !== request.revision) this.cancel(request);
    }
    for (const [id, open] of this.open()) {
      const turn = this.turns.get(id);
      if (!turn || (open.closing && turn.revision !== open.revision)) {
        this.clearClosing(id);
        this.set(id, undefined);
      }
      else if (open.closing) continue;
      else if (turn.revision !== open.revision) {
        this.set(id, { revision: turn.revision, previous: [] });
        this.load(id, firstPage);
      } else if (!open.page && !open.requested && !open.error) {
        this.load(id, firstPage);
      } else if (available && open.error === 'unavailable') {
        this.load(id, open.requested ?? firstPage);
      }
    }
  }

  pause(): void {
    this.available = false;
    for (const request of this.pending.values()) this.cancel(request);
    for (const [id, open] of this.open())
      if (open.requested && !open.error) this.set(id, { ...open, error: 'unavailable' });
  }

  toggle(id: string, expanded: boolean): void {
    const open = this.open().get(id);
    this.clearClosing(id);
    if (!expanded) {
      const pending = this.pending.get(id);
      if (pending) this.cancel(pending);
      if (!open?.page) this.set(id, undefined);
      else {
        this.set(id, { ...open, requested: undefined, error: undefined, closing: true });
        this.closing.set(id, setTimeout(() => {
          this.closing.delete(id);
          this.set(id, undefined);
        }, DISCLOSURE_EXIT_MS));
      }
      return;
    }
    if (open?.closing) {
      this.set(id, { ...open, closing: undefined });
      return;
    }
    const revision = this.turns.get(id)?.revision;
    if (!revision || open) return;
    this.set(id, { revision, previous: [] });
    this.load(id, firstPage);
  }

  hint(id: string): void {
    const turn = this.turns.get(id);
    const selection = this.selection;
    if (!turn || !selection || !this.available || this.pending.size || this.open().has(id) ||
      turn.total > SESSION_CHAT_TURN_WORK_LIMIT || this.cache.get(selection, id, turn.revision, 0)) return;
    this.prefetch = this.request(selection, id, turn.revision, 0);
  }

  navigate(id: string, action: 'previous' | 'next' | 'retry'): void {
    const open = this.open().get(id);
    if (!open || open.closing || (open.requested && !open.error)) return;
    if (action === 'retry') {
      if (open.error && open.error !== 'changed') this.load(id, open.requested ?? firstPage);
      return;
    }
    if (!open.page) return;
    const offset = action === 'previous' ? open.previous.at(-1) : open.page.nextOffset;
    if (offset != null) this.load(id, { offset, previous: action === 'previous'
      ? open.previous.slice(0, -1) : [...open.previous, open.page.offset] });
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

  private load(id: string, position: WorkPosition): void {
    const selection = this.selection;
    const open = this.open().get(id);
    if (!selection || !open) return;
    const cached = this.cache.get(selection, id, open.revision, position.offset);
    if (cached) {
      this.set(id, { revision: open.revision, page: cached, previous: position.previous });
      return;
    }
    this.set(id, { ...open, requested: position, error: this.available ? undefined : 'unavailable' });
    if (!this.available) return;
    // A click on the prefetched turn takes over the same request. Speculation
    // for any other turn yields immediately to the requested activity.
    const active = this.pending.get(id);
    if (active?.offset === position.offset && active.revision === open.revision) {
      if (this.prefetch === active) this.prefetch = undefined;
      return;
    }
    if (this.prefetch) this.cancel(this.prefetch);
    if (active) this.cancel(active);
    this.request(selection, id, open.revision, position.offset);
  }

  private request(selection: ChatSelection, turnId: string, revision: string, offset: number): WorkRequest {
    const request = { id: crypto.randomUUID(), turnId, revision, offset };
    this.pending.set(turnId, request);
    void this.receive(selection, request);
    return request;
  }

  private async receive(selection: ChatSelection, request: WorkRequest): Promise<void> {
    const { turnId, revision, offset } = request;
    const result = await this.client.turnWork(selection.scopeId, {
      taskId: selection.taskId, sessionId: selection.sessionId,
      turnId, revision, offset, requestId: request.id, deferToolDetails: true,
    });
    if (this.pending.get(turnId) !== request || this.selection !== selection) return;
    this.pending.delete(turnId);
    if (this.prefetch === request) this.prefetch = undefined;
    const turn = this.turns.get(turnId);
    if (turn?.revision !== revision) return;
    const open = this.open().get(turnId);
    const position = open?.requested;
    if (result.ok && result.value.total === turn.total) {
      const page = result.value;
      this.cache.put(selection, page);
      if (open?.revision === revision && position?.offset === offset)
        this.set(turnId, { revision, page, previous: position.previous });
    } else if (open?.revision === revision && position?.offset === offset) {
      this.set(turnId, { ...open, error: !result.ok && result.error.status === 409 ? 'changed' : 'failed' });
    }
  }

  private cancel(request: WorkRequest): void {
    if (this.selection) this.client.cancel(this.selection.scopeId, request.id);
    this.pending.delete(request.turnId);
    if (this.prefetch === request) this.prefetch = undefined;
  }

  private clearClosing(id: string): void {
    clearTimeout(this.closing.get(id));
    this.closing.delete(id);
  }
}
