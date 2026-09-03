import { computed, signal } from '@angular/core';
import type {
  ClaudeBackgroundWorkItem,
  ClaudeHookEvent,
  ClaudePendingPrompt,
  ClaudePermissionRequest,
  ClaudeRunPhase,
  ClaudeRuntimeEvent,
  ClaudeSubagentState,
  ClaudeToolProgress,
  ClaudeTranscriptItem,
  ClaudeUserInputRequest,
} from '@/shared/models/claude-runtime.model';
import {
  PairedTranscriptUnit,
  pairTranscript,
} from '@/features/session/claude-workspace/util/paired-transcript';
import {
  TranscriptRenderItem,
  buildTranscriptRenderItems,
} from '@/features/session/claude-workspace/util/transcript-render-items';

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
 * Holds the same runtime state the session workspace does — tool calls,
 * thinking, background work, permission prompts — so an embedded chat renders
 * with the full transcript UI rather than a stripped-down bubble list.
 * Deliberately a plain class rather than a component so the fiddly
 * live-vs-history reconciliation can be unit tested directly.
 */
export class ForkedChatTranscript {
  readonly history = signal<ClaudeTranscriptItem[]>([]);
  readonly live = signal<ClaudeTranscriptItem[]>([]);
  readonly optimistic = signal<ForkedChatVisibleItem[]>([]);
  readonly runPhase = signal<ClaudeRunPhase>('idle');
  readonly canInterrupt = signal(false);
  readonly lastError = signal<string | null>(null);
  readonly backgroundWork = signal<ClaudeBackgroundWorkItem[]>([]);
  readonly pendingPrompts = signal<ClaudePendingPrompt[]>([]);
  readonly pendingPermissionRequest = signal<ClaudePermissionRequest | null>(null);
  readonly pendingUserInputRequest = signal<ClaudeUserInputRequest | null>(null);
  readonly toolProgressByToolUseId = signal<Record<string, ClaudeToolProgress>>({});
  readonly subagents = signal<ClaudeSubagentState[]>([]);
  readonly recentHookEvents = signal<ClaudeHookEvent[]>([]);

  /**
   * Every item this surface owns, guard wrappers already stripped. Includes
   * tool calls, thinking and system notices — the transcript view decides what
   * to show, exactly as it does for a full session.
   */
  readonly items = computed<ClaudeTranscriptItem[]>(() => {
    const history = this.history();

    // Live and persisted items use different id formats but share
    // `sourceMessageId`. Hide a live item the moment its persisted counterpart
    // arrives so the same answer never renders twice — and so a stale history
    // refresh cannot make an in-flight answer disappear.
    const persisted = this.persistedKeys(history);
    const live = this.live().filter(
      (item) => !item.sourceMessageId || !persisted.has(this.key(item)),
    );

    const merged: ClaudeTranscriptItem[] = [
      ...history,
      ...this.optimistic(),
      ...live,
    ].sort((left, right) => (left.timestamp || '').localeCompare(right.timestamp || ''));

    // Drop the inherited parent conversation.
    const start = merged.findIndex((item) => this.isOwnPrompt(item));
    if (start < 0) return [];

    return merged.slice(start).map((item) => this.sanitized(item));
  });

  readonly topLevelItems = computed(() =>
    this.items().filter((item) => !item.parentToolUseId),
  );

  /** Subagent transcripts, keyed by the Agent tool call that spawned them. */
  readonly childItemsByParentToolUseId = computed(() => {
    const grouped: Record<string, ClaudeTranscriptItem[]> = {};
    for (const item of this.items()) {
      if (!item.parentToolUseId) continue;
      grouped[item.parentToolUseId] = [...(grouped[item.parentToolUseId] ?? []), item];
    }
    return grouped;
  });

  readonly units = computed<PairedTranscriptUnit[]>(() =>
    pairTranscript(this.topLevelItems()),
  );

  readonly renderItems = computed<TranscriptRenderItem[]>(() =>
    buildTranscriptRenderItems({
      units: this.units(),
      settled: this.runPhase() === 'idle',
      childItemsByParentToolUseId: this.childItemsByParentToolUseId(),
      subagents: this.subagents(),
      hookEvents: this.recentHookEvents(),
    }),
  );

  readonly liveToolUseIds = computed(
    () =>
      new Set(
        this.live()
          .filter((item) => item.kind === 'tool_use' && item.toolUseId)
          .map((item) => item.toolUseId as string),
      ),
  );

  readonly lastLiveMessageId = computed(() => {
    const live = this.live();
    for (let i = live.length - 1; i >= 0; i--) {
      const item = live[i];
      if (item.kind === 'assistant' || item.kind === 'thinking') return item.id;
    }
    return null;
  });

  /** Only the newest live item is still receiving deltas. */
  readonly streamingMessageId = computed(() =>
    this.runPhase() === 'running' ? this.lastLiveMessageId() : null,
  );

  /** True before the first token of a reply lands, so the bubble can pulse. */
  readonly awaitingFirstToken = computed(
    () =>
      this.runPhase() === 'running' &&
      !this.live().some((item) => item.kind === 'assistant' || item.kind === 'thinking'),
  );

  constructor(private readonly lens: ForkedChatLens) {}

  childItemsForToolUse(toolUseId: string): ClaudeTranscriptItem[] {
    return this.childItemsByParentToolUseId()[toolUseId] ?? [];
  }

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
        this.backgroundWork.set(event.payload.backgroundWork ?? []);
        this.pendingPrompts.set(event.payload.pendingPrompts ?? []);
        this.pendingPermissionRequest.set(event.payload.pendingPermissionRequest);
        this.pendingUserInputRequest.set(event.payload.pendingUserInputRequest);
        return;
      case 'message_start':
      case 'thinking_start':
      case 'tool_use':
      case 'tool_result':
        this.upsertLive(event.payload.item);
        return;
      case 'message_delta':
      case 'thinking_delta':
        this.appendDelta(event.payload.itemId, event.payload.delta);
        return;
      case 'tool_progress':
        this.toolProgressByToolUseId.update((items) => ({
          ...items,
          [event.payload.progress.toolUseId]: event.payload.progress,
        }));
        return;
      case 'background_work':
        this.backgroundWork.set(event.payload.backgroundWork ?? []);
        return;
      case 'subagent_lifecycle':
        this.subagents.update((items) => [
          event.payload.subagent,
          ...items.filter((agent) => agent.agentId !== event.payload.subagent.agentId),
        ]);
        return;
      case 'hook_event':
        this.recentHookEvents.update((items) =>
          [event.payload.hookEvent, ...items].slice(0, 50),
        );
        return;
      case 'permission_request':
        this.pendingPermissionRequest.set(event.payload.request);
        return;
      case 'permission_resolved':
        this.pendingPermissionRequest.set(null);
        this.live.update((items) =>
          items.map((item) =>
            item.kind === 'tool_use' && item.toolUseId === event.payload.toolUseId
              ? { ...item, interaction: event.payload.interaction }
              : item,
          ),
        );
        return;
      case 'user_input_request':
        this.pendingUserInputRequest.set(event.payload.request);
        return;
      case 'error': {
        const now = new Date().toISOString();
        this.lastError.set(event.payload.message);
        this.live.update((items) => [
          ...items,
          {
            id: `forked-chat-err-${Date.now()}`,
            kind: 'error',
            content: event.payload.message,
            timestamp: now,
            receivedAt: now,
          },
        ]);
        return;
      }
      case 'complete':
        this.runPhase.set('idle');
        this.canInterrupt.set(false);
        this.pendingPermissionRequest.set(null);
        this.pendingUserInputRequest.set(null);
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

  reset(): void {
    this.history.set([]);
    this.live.set([]);
    this.optimistic.set([]);
    this.runPhase.set('idle');
    this.canInterrupt.set(false);
    this.lastError.set(null);
    this.backgroundWork.set([]);
    this.pendingPrompts.set([]);
    this.pendingPermissionRequest.set(null);
    this.pendingUserInputRequest.set(null);
    this.toolProgressByToolUseId.set({});
    this.subagents.set([]);
    this.recentHookEvents.set([]);
  }

  private sanitized(item: ClaudeTranscriptItem): ClaudeTranscriptItem {
    if (item.kind !== 'user') return item;
    const content = this.lens.sanitizeUserContent(item.content);
    return content === item.content ? item : { ...item, content };
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
    backgroundWork?: ClaudeBackgroundWorkItem[];
    pendingPrompts?: ClaudePendingPrompt[];
    pendingPermissionRequest?: ClaudePermissionRequest | null;
    pendingUserInputRequest?: ClaudeUserInputRequest | null;
    subagents?: ClaudeSubagentState[];
    recentHookEvents?: ClaudeHookEvent[];
  }): void {
    this.live.set(state.liveItems ?? []);
    this.runPhase.set(state.runPhase ?? 'idle');
    this.canInterrupt.set(Boolean(state.canInterrupt));
    this.lastError.set(state.lastError ?? null);
    this.backgroundWork.set(state.backgroundWork ?? []);
    this.pendingPrompts.set(state.pendingPrompts ?? []);
    this.pendingPermissionRequest.set(state.pendingPermissionRequest ?? null);
    this.pendingUserInputRequest.set(state.pendingUserInputRequest ?? null);
    this.subagents.set(state.subagents ?? []);
    this.recentHookEvents.set(state.recentHookEvents ?? []);
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
