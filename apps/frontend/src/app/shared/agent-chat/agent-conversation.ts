import {
  PairedTranscriptUnit,
  pairTranscript,
} from '@/shared/agent-chat/transcript/paired-transcript';
import {
  buildTranscriptRenderItems,
  TranscriptRenderItem,
  TurnChangeCache,
} from '@/shared/agent-chat/transcript/transcript-render-items';
import type {
  AgentBackgroundWorkItem,
  AgentHookEvent,
  AgentPendingPrompt,
  AgentPermissionRequest,
  AgentRunPhase,
  AgentRuntimeEvent,
  AgentRuntimeState,
  AgentSubagentState,
  AgentToolProgress,
  AgentTranscriptItem,
  AgentUserInputRequest,
} from '@/shared/models/agent-runtime.model';
import { computed, signal } from '@angular/core';
import { reconcileHistoryIdentities } from './transcript/history-reconciliation';
import { persistedLiveItems, transcriptItemKey } from './transcript/transcript-identity';

export type ConversationVisibleItem = Pick<
  AgentTranscriptItem,
  'id' | 'kind' | 'content' | 'timestamp' | 'authoredAt' | 'receivedAt' | 'sourceMessageId'
>;

/**
 * Per-surface rules for turning a forked session's raw transcript into the
 * messages that surface should show.
 *
 * A fork inherits its parent's entire conversation, so every consumer needs to
 * hide the inherited history and strip whatever guard wrapper it sends prompts
 * with. Only those two things differ between surfaces.
 */
export interface ConversationLens {
  /** Remove the surface's prompt guard so the user sees what they typed. */
  sanitizeUserContent(content: string | null | undefined): string;
  /**
   * Identifies the first message that belongs to *this* surface. Everything
   * before it is inherited parent context and is hidden.
   */
  isOwnPrompt(item: ConversationVisibleItem): boolean;
}

export const OPTIMISTIC_ID_PREFIX = 'chat-opt-';

/** Per-conversation state shared by session, review, plan and mission chat. */
export class AgentConversation {
  private readonly turnChangeCache = new TurnChangeCache();
  readonly loading = signal(true);
  readonly history = signal<AgentTranscriptItem[]>([]);
  readonly live = signal<AgentTranscriptItem[]>([]);
  readonly optimistic = signal<AgentTranscriptItem[]>([]);
  readonly runPhase = signal<AgentRunPhase>('idle');
  readonly canInterrupt = signal(false);
  readonly lastError = signal<string | null>(null);
  readonly backgroundWork = signal<AgentBackgroundWorkItem[]>([]);
  readonly pendingPrompts = signal<AgentPendingPrompt[]>([]);
  readonly queuePaused = signal(false);
  readonly pendingPermissionRequest = signal<AgentPermissionRequest | null>(null);
  readonly pendingUserInputRequest = signal<AgentUserInputRequest | null>(null);
  readonly toolProgressByToolUseId = signal<Record<string, AgentToolProgress>>({});
  readonly subagents = signal<AgentSubagentState[]>([]);
  readonly recentHookEvents = signal<AgentHookEvent[]>([]);
  private readonly sortedHistory = computed(() => sortByTimestamp(this.history()));
  private readonly sortedLive = computed(() => sortByTimestamp(this.live()));
  private readonly sortedOptimistic = computed(() => sortByTimestamp(this.optimistic()));

  /**
   * Every item this surface owns, guard wrappers already stripped. Includes
   * tool calls, thinking and system notices — the transcript view decides what
   * to show, exactly as it does for a full session.
   */
  readonly items = computed<AgentTranscriptItem[]>(() => {
    const history = this.sortedHistory();

    // Live and persisted items use different id formats but share
    // `sourceMessageId`. Hide a live item the moment its persisted counterpart
    // arrives so the same answer never renders twice — and so a stale history
    // refresh cannot make an in-flight answer disappear.
    const persisted = persistedLiveItems(history, this.sortedLive());
    const live = this.sortedLive().filter((item) => !this.isFullyPersisted(item, persisted));
    const replacedHistoryIds = new Set(
      live.map((item) => persisted.get(transcriptItemKey(item))?.id),
    );
    const merged = mergeSorted(
      mergeSorted(
        history.filter((item) => !replacedHistoryIds.has(item.id)),
        this.sortedOptimistic(),
      ),
      live,
    );

    if (!this.lens) return merged;
    const start = merged.findIndex((item) => this.isOwnPrompt(item));
    return start < 0 ? [] : merged.slice(start).map((item) => this.sanitized(item));
  });

  readonly topLevelItems = computed(() => this.items().filter((item) => !item.parentToolUseId));

  /** Subagent transcripts, keyed by the Agent tool call that spawned them. */
  readonly childItemsByParentToolUseId = computed(() => {
    const grouped: Record<string, AgentTranscriptItem[]> = {};
    for (const item of this.items()) {
      if (!item.parentToolUseId) continue;
      (grouped[item.parentToolUseId] ??= []).push(item);
    }
    return grouped;
  });

  readonly units = computed<PairedTranscriptUnit[]>(() => pairTranscript(this.topLevelItems()));

  readonly renderItems = computed<TranscriptRenderItem[]>(() =>
    buildTranscriptRenderItems(
      {
        units: this.units(),
        settled: this.runPhase() === 'idle',
        childItemsByParentToolUseId: this.childItemsByParentToolUseId(),
        subagents: this.subagents(),
        hookEvents: this.recentHookEvents(),
      },
      this.turnChangeCache,
    ),
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

  private readonly acknowledgedUserIds = new Set<string>();
  private optimisticSequence = 0;

  constructor(private readonly lens: ConversationLens | null = null) {}

  childItemsForToolUse(toolUseId: string): AgentTranscriptItem[] {
    return this.childItemsByParentToolUseId()[toolUseId] ?? [];
  }

  apply(event: AgentRuntimeEvent): void {
    switch (event.type) {
      case 'session_snapshot':
        this.applyHistoryRefresh(event.payload.history ?? []);
        this.applyRuntimeState(event.payload);
        this.loading.set(false);
        return;
      case 'runtime_snapshot':
        this.applyRuntimeState(event.payload);
        return;
      case 'history_snapshot':
        this.applyHistoryRefresh(event.payload.history ?? []);
        this.loading.set(false);
        return;
      case 'run_state':
        this.runPhase.set(event.payload.runPhase);
        this.canInterrupt.set(event.payload.canInterrupt);
        this.lastError.set(event.payload.lastError);
        this.backgroundWork.set(event.payload.backgroundWork ?? []);
        this.pendingPrompts.set(event.payload.pendingPrompts ?? []);
        this.queuePaused.set(event.payload.queuePaused ?? false);
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
        this.recentHookEvents.update((items) => [event.payload.hookEvent, ...items].slice(0, 50));
        return;
      case 'permission_request':
        this.pendingPermissionRequest.set(event.payload.request);
        return;
      case 'permission_resolved':
        if (this.pendingPermissionRequest()?.requestId === event.payload.requestId) {
          this.pendingPermissionRequest.set(null);
        }
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
        this.loading.set(false);
        this.live.update((items) => [
          ...items,
          {
            id: `chat-err-${crypto.randomUUID()}`,
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
        if (this.pendingUserInputRequest()?.isBlocking !== false) {
          this.pendingUserInputRequest.set(null);
        }
        return;
      default:
        return;
    }
  }

  addOptimisticPrompt(text: string): AgentTranscriptItem {
    const now = new Date().toISOString();
    const item: AgentTranscriptItem = {
      id: `${OPTIMISTIC_ID_PREFIX}${Date.now()}-${++this.optimisticSequence}`,
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
  applyHistoryRefresh(history: AgentTranscriptItem[]): void {
    history = reconcileHistoryIdentities(history, this.live());
    this.reconcileOptimistic(history);
    this.history.set(history);
    const persisted = persistedLiveItems(history, this.live());
    this.live.update((items) => items.filter((item) => !this.isFullyPersisted(item, persisted)));
  }

  reset(): void {
    this.turnChangeCache.clear();
    this.acknowledgedUserIds.clear();
    this.loading.set(true);
    this.history.set([]);
    this.live.set([]);
    this.optimistic.set([]);
    this.runPhase.set('idle');
    this.canInterrupt.set(false);
    this.lastError.set(null);
    this.backgroundWork.set([]);
    this.pendingPrompts.set([]);
    this.queuePaused.set(false);
    this.pendingPermissionRequest.set(null);
    this.pendingUserInputRequest.set(null);
    this.toolProgressByToolUseId.set({});
    this.subagents.set([]);
    this.recentHookEvents.set([]);
  }

  private sanitized(item: AgentTranscriptItem): AgentTranscriptItem {
    if (item.kind !== 'user') return item;
    const content = this.sanitizeUserContent(item.content);
    return content === item.content ? item : { ...item, content };
  }

  private isOwnPrompt(item: ConversationVisibleItem): boolean {
    return (
      item.kind === 'user' &&
      (item.id.startsWith(OPTIMISTIC_ID_PREFIX) || !!this.lens?.isOwnPrompt(item))
    );
  }

  applyRuntimeState(state: Partial<AgentRuntimeState>): void {
    this.reconcileOptimistic(state.liveItems ?? []);
    this.live.set(state.liveItems ?? []);
    this.runPhase.set(state.runPhase ?? 'idle');
    this.canInterrupt.set(Boolean(state.canInterrupt));
    this.lastError.set(state.lastError ?? null);
    this.backgroundWork.set(state.backgroundWork ?? []);
    this.pendingPrompts.set(state.pendingPrompts ?? []);
    this.queuePaused.set(state.queuePaused ?? false);
    this.pendingPermissionRequest.set(state.pendingPermissionRequest ?? null);
    this.pendingUserInputRequest.set(state.pendingUserInputRequest ?? null);
    this.subagents.set(state.subagents ?? []);
    this.recentHookEvents.set(state.recentHookEvents ?? []);
    this.toolProgressByToolUseId.set(
      state.latestToolProgress
        ? { [state.latestToolProgress.toolUseId]: state.latestToolProgress }
        : {},
    );
  }

  private upsertLive(item: AgentTranscriptItem): void {
    if (item.kind === 'user') this.reconcileOptimistic([item]);
    this.live.update((items) => [...items.filter((existing) => existing.id !== item.id), item]);
  }

  appendDeltas(deltas: ReadonlyMap<string, string>): void {
    this.live.update((items) =>
      items.map((item) => {
        const delta = deltas.get(item.id);
        return delta ? { ...item, content: (item.content ?? '') + delta } : item;
      }),
    );
  }

  private appendDelta(itemId: string, delta: string): void {
    this.appendDeltas(new Map([[itemId, delta]]));
  }

  /** Match each newly acknowledged user message once, preserving repeated prompts. */
  private reconcileOptimistic(history: AgentTranscriptItem[]): void {
    for (const item of this.history()) {
      if (item.kind === 'user') this.acknowledgedUserIds.add(this.userIdentity(item));
    }
    const candidates = history.filter(
      (item) => item.kind === 'user' && !this.acknowledgedUserIds.has(this.userIdentity(item)),
    );
    if (!candidates.length) return;
    this.optimistic.update((items) => {
      const remaining = [...items];
      for (const candidate of candidates) {
        this.acknowledgedUserIds.add(this.userIdentity(candidate));
        const content = this.sanitizeUserContent(candidate.content);
        const index = remaining.findIndex((item) => {
          if (this.sanitizeUserContent(item.content) !== content) return false;
          // Old inherited prompts must not acknowledge newly submitted ones.
          const persistedAt = isoTimestamp(candidate.authoredAt ?? candidate.timestamp);
          const submittedAt = isoTimestamp(item.authoredAt ?? item.timestamp);
          return persistedAt === null || submittedAt === null || persistedAt >= submittedAt;
        });
        if (index !== -1) remaining.splice(index, 1);
      }
      return remaining;
    });
  }

  private sanitizeUserContent(content: string | null | undefined): string {
    return this.lens?.sanitizeUserContent(content) ?? (content ?? '').trim();
  }

  private userIdentity(item: AgentTranscriptItem): string {
    return item.sourceMessageId ? transcriptItemKey(item) : item.id;
  }

  private isFullyPersisted(
    item: AgentTranscriptItem,
    persisted: ReadonlyMap<string, AgentTranscriptItem>,
  ): boolean {
    const saved = persisted.get(transcriptItemKey(item));
    return !!saved && (saved.content?.length ?? 0) >= (item.content?.length ?? 0);
  }
}

function sortByTimestamp(items: AgentTranscriptItem[]): AgentTranscriptItem[] {
  return [...items].sort((left, right) =>
    (left.timestamp || '').localeCompare(right.timestamp || ''),
  );
}

/** History is sorted only when it changes; each streamed delta needs a linear merge. */
function mergeSorted(
  left: AgentTranscriptItem[],
  right: AgentTranscriptItem[],
): AgentTranscriptItem[] {
  const merged: AgentTranscriptItem[] = [];
  let l = 0;
  let r = 0;
  while (l < left.length && r < right.length) {
    merged.push(left[l].timestamp <= right[r].timestamp ? left[l++] : right[r++]);
  }
  return merged.concat(left.slice(l), right.slice(r));
}

function isoTimestamp(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
