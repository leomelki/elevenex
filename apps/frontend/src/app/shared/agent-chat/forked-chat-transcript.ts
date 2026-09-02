import { computed, signal } from '@angular/core';
import type {
  ClaudeRunPhase,
  ClaudeRuntimeEvent,
  ClaudeTranscriptItem,
} from '@/shared/models/claude-runtime.model';

export type ForkedChatVisibleItem = Pick<
  ClaudeTranscriptItem,
  | 'id'
  | 'kind'
  | 'content'
  | 'timestamp'
  | 'authoredAt'
  | 'receivedAt'
  | 'sourceMessageId'
>;

/**
 * Per-surface rules for turning a forked session's raw transcript into the
 * messages that surface should show.
 *
 * A fork inherits its parent's entire conversation, so every consumer needs to
 * hide the inherited history and strip whatever guard wrapper it sends prompts
 * with. Only those two things differ between surfaces.
 */
export interface ForkedChatLens {
  /** Remove the surface's prompt guard so the user sees what they typed. */
  sanitizeUserContent(content: string | null | undefined): string;
  /**
   * Identifies the first message that belongs to *this* surface. Everything
   * before it is inherited parent context and is hidden.
   */
  isOwnPrompt(item: ForkedChatVisibleItem): boolean;
}

export const OPTIMISTIC_ID_PREFIX = 'forked-chat-opt-';

/**
 * Reducer for an embedded chat on a forked session.
 *
 * Extracted from the plan Q&A panel so review discussions share one
 * implementation. Deliberately a plain class rather than a component so the
 * fiddly live-vs-history reconciliation can be unit tested directly.
 */
export class ForkedChatTranscript {
  readonly history = signal<ClaudeTranscriptItem[]>([]);
  readonly live = signal<ClaudeTranscriptItem[]>([]);
  readonly optimistic = signal<ForkedChatVisibleItem[]>([]);
  readonly runPhase = signal<ClaudeRunPhase>('idle');
  readonly canInterrupt = signal(false);
  readonly lastError = signal<string | null>(null);

  readonly items = computed<ForkedChatVisibleItem[]>(() => {
    const history = this.history();

    // Live and persisted items use different id formats but share
    // `sourceMessageId`. Hide a live item the moment its persisted counterpart
    // arrives so the same answer never renders twice — and so a stale history
    // refresh cannot make an in-flight answer disappear.
    const persisted = this.persistedKeys(history);
    const live = this.live().filter(
      (item) => !item.sourceMessageId || !persisted.has(this.key(item)),
    );

    const merged = [...history, ...this.optimistic(), ...live]
      .filter(
        (item): item is ForkedChatVisibleItem =>
          item.kind === 'user' ||
          item.kind === 'assistant' ||
          item.kind === 'error',
      )
      .sort((left, right) =>
        (left.timestamp || '').localeCompare(right.timestamp || ''),
      );

    // Drop the inherited parent conversation.
    const start = merged.findIndex((item) => this.isOwnPrompt(item));
    return start < 0 ? [] : merged.slice(start);
  });

  constructor(private readonly lens: ForkedChatLens) {}

  apply(event: ClaudeRuntimeEvent): void {
    switch (event.type) {
      case 'session_snapshot':
        this.history.set(event.payload.history ?? []);
        this.reconcileOptimistic(event.payload.history ?? []);
        this.applyRuntimeState(event.payload);
        return;
      case 'runtime_snapshot':
        this.applyRuntimeState(event.payload);
        return;
      case 'history_snapshot':
        this.history.set(event.payload.history ?? []);
        this.reconcileOptimistic(event.payload.history ?? []);
        return;
      case 'run_state':
        this.runPhase.set(event.payload.runPhase);
        this.canInterrupt.set(event.payload.canInterrupt);
        this.lastError.set(event.payload.lastError);
        return;
      case 'message_start':
        this.upsertLive(event.payload.item);
        return;
      case 'message_delta':
        this.appendDelta(event.payload.itemId, event.payload.delta);
        return;
      case 'error':
        this.lastError.set(event.payload.message);
        return;
      case 'complete':
        this.runPhase.set('idle');
        this.canInterrupt.set(false);
        return;
      default:
        return;
    }
  }

  addOptimisticPrompt(text: string): ForkedChatVisibleItem {
    const now = new Date().toISOString();
    const item: ForkedChatVisibleItem = {
      id: `${OPTIMISTIC_ID_PREFIX}${Date.now()}`,
      kind: 'user',
      content: text,
      timestamp: now,
      authoredAt: now,
    };
    this.optimistic.update((items) => [...items, item]);
    return item;
  }

  removeOptimistic(id: string): void {
    this.optimistic.update((items) => items.filter((item) => item.id !== id));
  }

  /**
   * Fold a freshly fetched history in without losing anything still streaming.
   *
   * Only live items that are now persisted are dropped: clearing outright would
   * wipe a second answer that began streaming while this refresh was in flight.
   */
  applyHistoryRefresh(history: ClaudeTranscriptItem[]): void {
    this.history.set(history);
    this.reconcileOptimistic(history);
    const persisted = this.persistedKeys(history);
    this.live.update((items) =>
      items.filter(
        (item) => !item.sourceMessageId || !persisted.has(this.key(item)),
      ),
    );
  }

  displayContent(item: ForkedChatVisibleItem): string {
    if (item.kind === 'user') {
      return this.lens.sanitizeUserContent(item.content);
    }
    return item.content?.trim() || '';
  }

  reset(): void {
    this.history.set([]);
    this.live.set([]);
    this.optimistic.set([]);
    this.runPhase.set('idle');
    this.canInterrupt.set(false);
    this.lastError.set(null);
  }

  private isOwnPrompt(item: ForkedChatVisibleItem): boolean {
    return (
      item.kind === 'user' &&
      (item.id.startsWith(OPTIMISTIC_ID_PREFIX) || this.lens.isOwnPrompt(item))
    );
  }

  private applyRuntimeState(state: {
    liveItems?: ClaudeTranscriptItem[];
    runPhase?: ClaudeRunPhase;
    canInterrupt?: boolean;
    lastError?: string | null;
  }): void {
    this.live.set(state.liveItems ?? []);
    this.runPhase.set(state.runPhase ?? 'idle');
    this.canInterrupt.set(Boolean(state.canInterrupt));
    this.lastError.set(state.lastError ?? null);
  }

  private upsertLive(item: ClaudeTranscriptItem): void {
    this.live.update((items) => [
      ...items.filter((existing) => existing.id !== item.id),
      item,
    ]);
  }

  private appendDelta(itemId: string, delta: string): void {
    this.live.update((items) =>
      items.map((item) =>
        item.id === itemId
          ? { ...item, content: `${item.content ?? ''}${delta}` }
          : item,
      ),
    );
  }

  /**
   * Optimistic items carry a client-generated id, so they can only be matched
   * against history by their (sanitized) text.
   */
  private reconcileOptimistic(history: ClaudeTranscriptItem[]): void {
    const seen = new Set(
      history
        .filter((item) => item.kind === 'user')
        .map((item) => this.lens.sanitizeUserContent(item.content)),
    );
    this.optimistic.update((items) =>
      items.filter(
        (item) => !seen.has(this.lens.sanitizeUserContent(item.content)),
      ),
    );
  }

  private persistedKeys(history: ClaudeTranscriptItem[]): Set<string> {
    return new Set(
      history.filter((item) => item.sourceMessageId).map((item) => this.key(item)),
    );
  }

  private key(item: Pick<ClaudeTranscriptItem, 'sourceMessageId' | 'kind'>): string {
    return `${item.sourceMessageId}|${item.kind}`;
  }
}
