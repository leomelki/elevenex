import { elementMarker, elementMarkersIn, serializeBrowserElements } from '@elevenex/shared';
import {
  DestroyRef,
  Injector,
  afterNextRender,
  effect,
  untracked,
  Injectable,
  computed,
  inject,
  signal,
} from "@angular/core";
import type {
  SessionChatAction,
  SessionChatCommandReply,
  SessionChatItem,
  SessionChatPage,
  SessionChatState,
  SessionChatTarget,
} from "@elevenex/shared";
import { BackendClientService } from '../backend/backend-client.service';
import { SessionChatOutbox } from './session-chat-outbox';
import { chatTailContext, retainChatWindow } from './session-chat-tail';
import { SessionChatLoadingPolicy, SESSION_CHAT_SLOW_OPEN_MS } from './session-chat-loading';
import { completedTurnRecords, SessionChatTurnWork, SessionChatWorkCache } from './session-chat-turn-work';
import { SessionChatToolCache, SessionChatToolDetails } from './session-chat-tool-details';
import { SessionChatClient } from "../backend/session-chat-client.service";
import type { ChatExchange, ChatHistoryRequest, ComposerSubmission, MessageSendOrigin, ConversationMention, QueuedMessage, WaitingMessage } from "../conversation";
import { SessionChatDrafts, SessionDraft, type StartingSession } from "./session-chat-drafts";
import {
  ChatTranscriptProjection,
  pendingPromptStart,
  withPendingPrompt,
  type PendingChatPrompt,
} from "./session-chat-transcript";
import { queuedDelivery, reconcileQueuedDeliveries, type QueuedDelivery } from './session-chat-queue-delivery';

interface PendingSubmission extends PendingChatPrompt {
  readonly sendOrigin?: MessageSendOrigin;
  readonly queue: boolean;
  readonly knownQueueIds: ReadonlySet<string>;
  confirmed: boolean;
}
interface TurnArrival {
  readonly renderId: string;
  readonly sendOrigin?: MessageSendOrigin;
}

function promptBefore(items: readonly SessionChatItem[], end: number): SessionChatItem | undefined {
  for (let index = end - 1; index >= 0; index--) {
    const item = items[index];
    if (item?.kind === 'user') return item;
  }
  return undefined;
}

export interface ChatSelection extends SessionChatTarget {
  readonly scopeId: string;
}
/** One mounted conversation owns its reads, incremental window and mutation epochs. */
@Injectable()
export class SessionChatStore {
  private readonly client = inject(SessionChatClient);
  private readonly injector = inject(Injector);
  readonly tools = new SessionChatToolDetails(this.client, inject(SessionChatToolCache), () => { void this.refresh(); });
  readonly work = new SessionChatTurnWork(this.client, inject(SessionChatWorkCache), {
    prepare: (items, ids, signal, turnId) => this.tools.prepare(items, ids, signal, turnId),
    afterReveal: release => { afterNextRender(release, { injector: this.injector }); },
  });
  private readonly transcript = new ChatTranscriptProjection();
  private readonly drafts = inject(SessionChatDrafts);
  private readonly loadingPolicy = inject(SessionChatLoadingPolicy);
  readonly progressiveLoading = this.loadingPolicy.progressive;
  private readonly backend = inject(BackendClientService);
  readonly outbox = inject(SessionChatOutbox, { optional: true });
  private readonly active = signal(true);
  setActive(active: boolean): void { this.active.set(active); }
  private readonly selectedScope = signal<string | null>(null);
  readonly offline = computed(() => !!this.selectedScope() && this.backend.state().scope?.id !== this.selectedScope());
  readonly waiting = computed(() => { const target = this.selectedTarget(); return this.outbox?.items().filter(item => `${item.target.taskId}/${item.target.sessionId}` === target) ?? []; });
  readonly waitingMessages = computed<readonly WaitingMessage[]>(() => this.waiting().filter(item => item.status === 'waiting' || item.status === 'sending').map(item => ({ id: item.id, text: item.label, kind: item.action.type === 'send' ? 'message' : 'action', state: item.status === 'sending' ? 'sending' : 'waiting', editable: item.action.type === 'send' && item.status === 'waiting', removable: item.status === 'waiting' })));
  readonly waitingPending = computed(() => this.waiting().some(item => item.status === 'waiting' || item.status === 'sending'));
  readonly waitingUncertain = computed(() => this.waiting().some(item => item.status === 'unknown'));
  private selection: ChatSelection | null = null;
  private readonly selectedTarget = signal<string>('');
  private entry = new SessionDraft();
  private readonly activeEntry = signal(this.entry);
  private epoch = 0;
  private readEpoch = 0;
  private cursor: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private slowOpenTimer: ReturnType<typeof setTimeout> | undefined;
  private request: string | undefined;
  private requestMode: 'window' | 'progressive' | undefined;
  private streamAvailable = false;
  private stream?: { readonly first: Promise<boolean>; close(): void };
  private disposed = false;
  private seenRequest: string | undefined;
  private readonly commands = new Map<string, string>();
  // Preserve unchanged inputs when a page or a stream update crosses IPC.
  readonly state = signal<SessionChatState | null>(null, { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  readonly items = signal<readonly SessionChatItem[]>([], { equal: (a, b) => a.length === b.length && a.every((item, index) => item === b[index]) });
  readonly leadingPrompt = signal<SessionChatItem | null>(null);
  private readonly trailingContext = signal<readonly SessionChatItem[]>([]);
  readonly fresh = signal<ReadonlySet<string>>(new Set(), { equal: (a, b) => a.size === b.size && [...a].every(id => b.has(id)) });
  readonly loading = signal(true);
  /** A new local conversation stays on its welcome view through initial hydration. */
  readonly starting = signal(false);
  readonly compactStart = signal(false);
  private startingId: string | null = null;
  /** UI lifetime survives a verified same-machine scope rebind. */
  readonly viewRevision = signal(0);
  readonly error = signal("");
  readonly promptEditError = signal('');
  readonly streamError = signal('');
  readonly defaultChange =
    signal<SessionChatCommandReply["defaultChange"]>(undefined);
  readonly presetRemoval = signal<SessionChatCommandReply["presetRemoval"]>(undefined);
  readonly notice = signal("");
  readonly busy = signal("");
  readonly readOnly = signal(false);
  readonly historical = signal(false);
  readonly before = signal<string | null>(null);
  readonly next = signal<string | null>(null);
  readonly historyLoading = signal(false);
  readonly historyError = signal("");
  readonly windowRevision = signal(0);
  private supportsFollowing = false;
  readonly draft = computed(() => this.activeEntry().text());
  readonly draftRestoring = computed(() => this.activeEntry().restoring());
  readonly draftError = computed(() => this.activeEntry().error());
  retryDraft(): void { this.entry.retry(); }
  readonly mentions = computed(() => this.activeEntry().mentions());
  addMention(mention: ConversationMention): void {
    if (!this.state()?.sessionMentions || mention.kind !== 'session' || this.readOnly() || this.busy() || this.uncertain()) return;
    const id = Number(mention.id);
    if (!Number.isSafeInteger(id) || id <= 0 || this.mentions().length >= 8 || this.mentions().some(item => item.id === mention.id)) return;
    this.entry.mentions.update(items => [...items, mention]);
  }
  removeMention(id: string): void {
    this.entry.mentions.update(items => items.filter(item => item.id !== id));
  }
  readonly uncertain = computed(() => this.busy() ? "" : this.activeEntry().uncertain());
  readonly checked = signal(false);
  private readonly pending = signal<PendingSubmission | null>(null);
  private readonly pendingQueue = signal<PendingSubmission | null>(null);
  private readonly queuedDeliveries = signal<ReadonlyMap<string, QueuedDelivery>>(new Map());
  // Keep local entry identity and source through a receipt that beats first paint.
  // Pruned with the bounded transcript and cleared on selection changes.
  private readonly turnArrivals = signal<ReadonlyMap<string, TurnArrival>>(new Map());
  private readonly decoratedTurns = new WeakMap<ChatExchange, {
    readonly arrival?: TurnArrival;
    readonly pending: PendingSubmission | null;
    readonly exchange: ChatExchange;
  }>();
  private readonly queueRenderIds = signal<ReadonlyMap<string, string>>(new Map());
  readonly dispatching = computed(() => !!this.state()?.dispatchingPrompts?.length);
  readonly running = computed(
    () =>
      this.state()?.phase === "running" ||
      this.state()?.phase === "waiting" ||
      this.dispatching() ||
      (!!this.pending() && !this.pending()?.queue),
  );
  readonly promptEditDisabledReason = computed(() => {
    const state = this.state();
    if (this.readOnly()) return 'This conversation is read only.';
    if (this.offline() || this.streamError()) return 'Reconnect to edit messages.';
    if (this.loading() || !state) return 'Wait for the conversation to load.';
    if (this.busy() || this.uncertain() || this.waitingUncertain()) return 'Check the current action before editing.';
    if (this.running() || state.canInterrupt || state.permission || state.question || state.work?.totalRunning)
      return 'Wait for the current turn and background work to finish.';
    if (this.queue().length || this.waitingPending()) return 'Resolve queued messages before editing.';
    return '';
  });
  readonly queue = computed<readonly QueuedMessage[]>(() => {
    const pending = this.pendingQueue(),
      queue = (this.state()?.queue ?? []).filter(item => !this.queuedDeliveries().has(item.id)).map((item): QueuedMessage => {
        const renderId = this.queueRenderIds().get(item.id);
        return renderId ? { ...item, renderId } : item;
      });
    return pending ? [...queue, { id: pending.id, text: pending.text, steerable: false, removable: false }] : queue;
  });
  readonly visibleItems = computed<readonly SessionChatItem[]>(() => {
    const leadingPrompt = this.leadingPrompt();
    const items = this.items();
    const context = this.trailingContext();
    const leading = leadingPrompt && items.length > 0 && items[0]?.kind !== 'user' &&
      !items.some(item => item.id === leadingPrompt.id)
      ? [leadingPrompt] : [];
    if (!context.length) return leading.length ? [...leading, ...items] : items;
    const ids = new Set([...leading, ...items].map(item => item.id));
    const trailing = context.filter(item => !ids.has(item.id));
    return [...leading, ...items, ...trailing];
  });
  /** Include the mounted reply and inspected work for media and original-content resolution. */
  readonly presentedItems = computed<readonly SessionChatItem[]>(() => {
    const work = this.work.open();
    return this.visibleItems().flatMap(item => {
      if (!item.completedTurn) return [item];
      const entry = work.get(item.id);
      const details = entry?.revision === item.completedTurn.revision ? entry : undefined;
      return [item, ...completedTurnRecords(item.completedTurn, details)];
    });
  }, { equal: (a, b) => a.length === b.length && a.every((item, index) => item === b[index]) });
  readonly exchanges = computed<readonly ChatExchange[]>(() => {
    const pending = this.pending();
    let items = this.visibleItems();
    let state = this.state();
    let fresh = this.fresh();
    if (!this.historical() && this.queuedDeliveries().size) {
      const deliveries = [...this.queuedDeliveries().values()].reverse();
      const tail = items.length;
      const previousPrompt = promptBefore(items, tail);
      for (const delivery of deliveries) {
        items = withPendingPrompt(items, delivery, delivery.local ? tail : undefined);
      }
      fresh = new Set([...fresh, ...deliveries.map(delivery => delivery.id)]);
      const dispatch = deliveries.find(delivery => !delivery.local);
      if (dispatch && state && (state.phase === 'idle' || state.phase === 'running' || state.phase === 'waiting'))
        state = { ...state, phase: state.phase === 'idle' ? 'running' : state.phase, activePromptId: dispatch.id };
      else if (state && !state.activePromptId && previousPrompt)
        state = { ...state, activePromptId: previousPrompt.id };
    }
    // A distant history window may no longer contain the send boundary.
    const showPending = pending && (!this.historical() || pendingPromptStart(items, pending) > 0);
    const exchanges = this.transcript.project(
      items,
      state,
      fresh,
      showPending ? pending : undefined,
      this.work.open(),
      !this.historical(),
    );
    if (!pending && !this.turnArrivals().size) return exchanges;
    return exchanges.map((exchange): ChatExchange => {
      const arrival = this.turnArrivals().get(exchange.id);
      const ownPending = exchange.id === pending?.id ? pending : null;
      if (!arrival && !ownPending) return exchange;
      const old = this.decoratedTurns.get(exchange);
      if (old && old.arrival === arrival && old.pending === ownPending) return old.exchange;
      const decorated = ownPending ? {
          ...exchange,
          isNew: true,
          sendOrigin: ownPending.sendOrigin,
          status: this.running() ? "live" : exchange.status,
        } satisfies ChatExchange : { ...exchange, ...arrival, isNew: true };
      this.decoratedTurns.set(exchange, { arrival, pending: ownPending, exchange: decorated });
      return decorated;
    });
  }, { equal: (left, right) => left.length === right.length && left.every((exchange, index) => exchange === right[index]) });
  readonly empty = computed(() => !this.exchanges().length && !this.running());

  /** Called only after the focused view has rendered its latest content. */
  async markSeen(): Promise<void> {
    const selection = this.selection, at = this.state()?.unseenCompletionAt;
    if (!selection || !at || this.disposed || this.offline() || !this.active() || this.loading() || this.historical() || this.next()) return;
    const epoch = this.epoch, key = `${selection.scopeId}:${selection.sessionId}:${at}`;
    if (this.seenRequest === key) return;
    this.seenRequest = key;
    try {
      const result = await this.client.command(selection.scopeId, {
        taskId: selection.taskId, sessionId: selection.sessionId,
        action: { type: 'mark-seen', completionAt: at },
      });
      if (result.ok && !this.disposed && this.epoch === epoch && this.state()?.unseenCompletionAt === at)
        this.state.update(state => state ? { ...state, unseenCompletionAt: null } : state);
    } finally {
      if (this.seenRequest === key) this.seenRequest = undefined;
    }
  }

  constructor() {
    effect(() => {
      if (this.progressiveLoading()) untracked(() => {
        // Another chat may have detected the slow connection while this one
        // was opening. Replace only pending initial reads, never mutations.
        if ((this.request || this.stream) && this.requestMode === 'window' && !this.state()) {
          this.stopRead();
          void this.load(true);
        }
      });
    });
    effect(() => {
      const items = this.visibleItems();
      // A verified rebind can preserve both the visible items and online state.
      const available = !!this.selectedTarget() && !!this.selectedScope() &&
        this.active() && !this.offline() && !document.hidden;
      untracked(() => {
        this.tools.setAvailable(available);
        this.work.sync(items, available);
      });
    });
    let wasPaused: boolean | undefined;
    effect(() => {
      const paused = this.offline() || !this.active();
      const resumed = wasPaused === true && !paused;
      wasPaused = paused;
      untracked(() => { if (paused) { this.stopRead(); this.loading.set(false); } else if (resumed && this.selection && !this.request) void this.load(false); });
    });
    const visible = () => {
      if (document.hidden) {
        this.stopRead();
        this.work.pause();
        this.tools.setAvailable(false);
      } else if (this.selection) {
        const available = this.active() && !this.offline();
        this.tools.setAvailable(available);
        this.work.sync(this.visibleItems(), available);
        void this.load(false);
      }
    };
    document.addEventListener("visibilitychange", visible);
    inject(DestroyRef).onDestroy(() => {
      this.outbox?.setEditing(null);
      this.remember();
      this.disposed = true;
      this.epoch++;
      this.stopRead();
      this.work.select(null);
      this.tools.select(null);
      this.transcript.clear();
      document.removeEventListener("visibilitychange", visible);
    });
  }

  openDraft(starting: StartingSession): void {
    if (this.startingId === starting.id && this.entry === starting.draft) { this.selectedScope.set(starting.scopeId); return; }
    this.outbox?.setEditing(null);
    this.remember(); this.stopRead(); this.epoch++;
    this.selection = null; this.startingId = starting.id; this.starting.set(true); this.compactStart.set(false);
    this.work.select(null);
    this.tools.select(null);
    this.transcript.clear();
    this.selectedTarget.set(''); this.selectedScope.set(starting.scopeId);
    this.entry = starting.draft; this.activeEntry.set(this.entry);
    this.state.set(null); this.items.set([]); this.leadingPrompt.set(null); this.trailingContext.set([]); this.before.set(null); this.next.set(null); this.historyLoading.set(false); this.historyError.set(''); this.cursor = undefined;
    this.pending.set(null); this.pendingQueue.set(null); this.turnArrivals.set(new Map()); this.queueRenderIds.set(new Map());
    this.queuedDeliveries.set(new Map());
    this.fresh.set(new Set()); this.error.set(''); this.notice.set(''); this.busy.set(''); this.checked.set(false);
    this.defaultChange.set(undefined); this.commands.clear(); this.readOnly.set(false); this.historical.set(false); this.loading.set(false);
    this.viewRevision.update(value => value + 1);
  }

  open(selection: ChatSelection, readOnly: boolean, streamAvailable = false): void {
    if (
      this.selection?.scopeId === selection.scopeId &&
      this.selection.sessionId === selection.sessionId &&
      this.selection.taskId === selection.taskId
    ) {
      const changed = this.readOnly() !== readOnly;
      const transportChanged = this.streamAvailable !== streamAvailable;
      this.readOnly.set(readOnly);
      this.streamAvailable = streamAvailable;
      if (changed || transportChanged) {
        this.stopRead();
        void this.load(changed);
      }
      return;
    }
    this.remember();
    const nextEntry = this.drafts.entry(selection);
    const startingHandoff = !!this.startingId && this.entry === nextEntry;
    this.startingId = null;
    if (!startingHandoff) { this.starting.set(false); this.compactStart.set(false); }
    this.outbox?.setEditing(null);
    const sameSession = this.selection?.taskId === selection.taskId && this.selection.sessionId === selection.sessionId;
    const previousEntry = this.entry, previousCursor = this.cursor, previousBefore = this.before(), historical = this.historical();
    this.stopRead();
    this.epoch++;
    this.selection = selection;
    this.streamAvailable = streamAvailable;
    this.selectedTarget.set(`${selection.taskId}/${selection.sessionId}`);
    this.selectedScope.set(selection.scopeId);
    this.entry = nextEntry;
    this.activeEntry.set(this.entry);
    const recovery = sameSession && previousEntry === this.entry;
    this.work.select(selection, recovery);
    this.tools.select(selection);
    if (!recovery) this.transcript.clear();
    this.readOnly.set(readOnly);
    this.pending.set(null);
    this.pendingQueue.set(null);
    if (!recovery) this.queuedDeliveries.set(new Map());
    if (!recovery && !startingHandoff) { this.viewRevision.update(value => value + 1); this.turnArrivals.set(new Map()); this.queueRenderIds.set(new Map()); }
    const cached = this.drafts.snapshot(selection.sessionId);
    if (!recovery) { this.items.set(cached?.items ?? []); this.leadingPrompt.set(cached?.leadingPrompt ?? null); this.trailingContext.set([]); this.state.set(cached?.state ?? null); }
    this.before.set(recovery ? previousBefore : cached?.before ?? null);
    if (!recovery) this.next.set(null);
    this.historyLoading.set(false); this.historyError.set('');
    if (!recovery) this.fresh.set(new Set());
    this.error.set("");
    this.notice.set("");
    this.defaultChange.set(undefined);
    this.commands.clear();
    this.busy.set("");
    this.historical.set(recovery && historical);
    this.checked.set(false);
    this.cursor = recovery ? previousCursor : cached?.cursor;
    this.loading.set(!this.state());
    void this.load(!recovery && !cached);
  }
  private remember(): void {
    const state = this.state();
    // Opening always means the latest conversation. A paged reading window is
    // not a usable opening snapshot: showing it before the tail would jump.
    if (this.selection && state && !this.historical() && !this.next())
      this.drafts.remember(this.selection, { items: this.items(), leadingPrompt: this.leadingPrompt(), state, cursor: this.cursor, before: this.before() });
  }
  setDraft(value: string): void {
    this.entry.setText(value);
  }
  private stopRead(): void {
    clearTimeout(this.timer);
    clearTimeout(this.slowOpenTimer);
    this.slowOpenTimer = undefined;
    this.timer = undefined;
    this.readEpoch++;
    this.stream?.close();
    this.stream = undefined;
    this.streamError.set('');
    if (this.request && this.selection)
      this.client.cancel(this.selection.scopeId, this.request);
    this.request = undefined;
    this.requestMode = undefined;
    this.historyLoading.set(false);
  }
  async refresh(): Promise<boolean> {
    this.stopRead();
    this.historyError.set('');
    return this.load(true);
  }
  async older(source: ChatHistoryRequest['source'] = 'reader'): Promise<void> {
    if (!this.before() || this.loading() || this.historyLoading()) return;
    this.stopRead();
    await this.load(false, this.before()!, "before", source === 'prefetch' && !this.historical());
  }
  async newer(): Promise<void> {
    if (!this.next() || this.loading() || this.historyLoading()) return;
    if (!this.supportsFollowing) { await this.refresh(); return; }
    this.stopRead();
    await this.load(false, this.next()!, "following");
  }
  cancelHistory(): void {
    if (!this.historyLoading()) return;
    this.stopRead();
    if (!this.readOnly()) void this.load(false);
  }
  private async load(reset: boolean, position?: string, direction?: "before" | "following", preserveTail = false): Promise<boolean> {
    const selection = this.selection;
    if (!selection || this.request || this.disposed || document.hidden || this.offline() || !this.active()) return false;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.streamAvailable && !this.readOnly() && !direction)
      return this.stream?.first ?? this.loadStream(selection, reset);
    const epoch = this.epoch,
      readEpoch = ++this.readEpoch,
      requestId = crypto.randomUUID();
    this.request = requestId;
    const profile = this.loadingPolicy.profile();
    this.requestMode = profile.loadingMode;
    if (reset || !this.state()) this.loading.set(true);
    if (direction) { this.historyLoading.set(true); this.historyError.set(""); }
    this.watchSlowOpen(selection, readEpoch, () => this.load(reset, position, direction, preserveTail));
    const result = await this.client.read(selection.scopeId, {
      taskId: selection.taskId,
      sessionId: selection.sessionId,
      requestId,
      ...profile,
      deferToolDetails: true,
      ...(position && direction
        ? { [direction]: position }
        : !reset && this.cursor
          ? { after: this.cursor }
          : {}),
    });
    if (this.disposed || epoch !== this.epoch || readEpoch !== this.readEpoch)
      return false;
    clearTimeout(this.slowOpenTimer);
    this.slowOpenTimer = undefined;
    this.request = undefined;
    this.requestMode = undefined;
    this.loading.set(false);
    this.historyLoading.set(false);
    if (result.ok) {
      this.error.set("");
      this.receivePage(result.value, reset, direction, preserveTail);
    } else if (direction) this.historyError.set(result.error.message);
    else if (reset || !this.state() || result.error.status === 404)
      this.error.set(
        result.error.status === 404
          ? "Chat is unavailable on this machine. Update its engine, then reconnect."
          : result.error.message,
      );
    if (this.streamAvailable && !this.readOnly()) {
      // A following page has already installed the latest rows. An append
      // based on the older live cursor would apply the same text a second time.
      if (direction === 'following' && result.ok && !result.value.next) this.cursor = undefined;
      void this.load(false);
    } else if (
      !this.readOnly() &&
      (result.ok ||
        (result.error.status !== 404 && result.error.code !== "stale-scope"))
    )
      this.timer = setTimeout(
        () => {
          this.timer = undefined;
          void this.load(false);
        },
        result.ok ? 80 : 3000,
      );
    return result.ok;
  }

  private watchSlowOpen(selection: ChatSelection, readEpoch: number, retry: () => Promise<boolean>): void {
    // Time only uncached openings. The smaller view is shared within the scope.
    if (this.state() || this.progressiveLoading()) return;
    this.slowOpenTimer = setTimeout(() => {
      if (this.disposed || readEpoch !== this.readEpoch || document.hidden || this.offline() || !this.active()) return;
      if (!this.loadingPolicy.enableProgressive(selection.scopeId)) return;
      this.stopRead();
      void retry();
    }, SESSION_CHAT_SLOW_OPEN_MS);
  }

  private loadStream(selection: ChatSelection, reset: boolean): Promise<boolean> {
    const readEpoch = ++this.readEpoch;
    const loadingMode = this.loadingPolicy.profile().loadingMode;
    const { scopeId, taskId, sessionId } = selection;
    let firstPage = true;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let finish!: (ok: boolean) => void;
    const first = new Promise<boolean>(resolve => { finish = resolve; });
    const current = () => !this.disposed && readEpoch === this.readEpoch &&
      this.active() && !this.offline() && !document.hidden;
    const fail = (message: string) => {
      this.stopRead();
      this.loading.set(false);
      this.streamError.set(message);
    };
    if (reset || !this.state()) this.loading.set(true);
    this.requestMode = loadingMode;
    this.watchSlowOpen(selection, readEpoch, () => this.load(reset));
    const watch = this.client.watch(scopeId, {
      taskId, sessionId, loadingMode, watchId: crypto.randomUUID(),
      ...(!reset && this.cursor ? { after: this.cursor } : {}),
    }, event => {
      if (!current()) return false;
      clearTimeout(reconnectTimer);
      if (event.type === 'closed') {
        fail(event.error.message);
      } else if (event.type === 'reconnecting') {
        // Retain the transcript and avoid a warning flash for quick recoveries.
        if (firstPage) finish(false);
        reconnectTimer = setTimeout(() => {
          if (!current()) return;
          this.loading.set(false);
          this.streamError.set('Reconnecting to this conversation…');
        }, 900);
      } else {
        const state = event.page.state ?? this.state();
        if (!state) {
          fail('The conversation stream did not provide its initial state.');
          return false;
        }
        clearTimeout(this.slowOpenTimer);
        this.slowOpenTimer = undefined;
        this.requestMode = undefined;
        this.loading.set(false);
        this.streamError.set('');
        if (firstPage && reset) this.error.set('');
        this.receivePage({ ...event.page, state }, firstPage && reset);
        firstPage = false;
        finish(true);
      }
      return true;
    });
    this.stream = { first, close: () => { clearTimeout(reconnectTimer); watch.close(); finish(false); } };
    void watch.started.then(result => {
      if (current() && !result.ok) fail(result.error.message);
    });
    return first;
  }

  private receivePage(page: SessionChatPage, reset: boolean, direction?: 'before' | 'following', preserveTail = false): void {
    if (this.starting()) this.compactStart.set(!!this.draft().trim());
    this.starting.set(false);
    this.supportsFollowing = page.next !== undefined;
    const rewritten = page.reset && page.state.historyRewrite &&
      page.state.historyRewrite !== this.state()?.historyRewrite;
    if (this.historical() && !direction && !reset && !rewritten) {
      // Keep runtime state current while the user reads another window.
      this.state.set(page.state);
      this.cursor = page.cursor;
      this.reconcileDelivery(page.state);
    } else this.accept(page, direction, preserveTail);
    if (this.uncertain()) this.checked.set(true);
  }

  private accept(page: SessionChatPage, direction?: "before" | "following", preserveTail = false): void {
    const previous = this.items();
    if (!direction && !page.reset && !page.events.length) {
      const { arrivals } = this.acceptQueuedDeliveries(page.state, previous, previous, false);
      if (arrivals.size) this.turnArrivals.update(current => {
        const next = new Map(current);
        for (const [id, renderId] of arrivals) next.set(id, { renderId });
        return next;
      });
      this.state.set(page.state);
      this.cursor = page.cursor;
      this.reconcileDelivery(page.state);
      return;
    }
    const older = direction === "before";
    // Initial prefetch can fill unused space. Only reader paging can evict the live end.
    const keepsOlder = older && !preserveTail;
    const wasLoaded = !!this.state();
    const replacesTail = !direction && page.reset;
    // A reset is authoritative from its first row onward. In the live window,
    // a matching first row shows where the loaded prefix joins the new page.
    const sharedStart = replacesTail && !this.historical() && page.before
      ? previous.findIndex(item => item.id === page.items[0]?.id) : -1;
    const previousPrefix = sharedStart > 0 ? previous.slice(0, sharedStart) : [];
    const priorOwner = promptBefore(previous, sharedStart) ?? this.leadingPrompt();
    const keepsPrefix = previousPrefix.length > 0 && (
      page.items[0]?.kind === 'user' || page.leadingPrompt === undefined ||
      JSON.stringify(page.leadingPrompt) === JSON.stringify(priorOwner)
    );
    const base = older ? [...page.items, ...previous]
      : direction ? [...previous, ...page.items]
      : keepsPrefix ? [...previousPrefix, ...page.items]
      : replacesTail ? page.items : previous;
    if (replacesTail && page.state.provider === 'claude' && this.state()?.provider === 'claude')
      this.transcript.reconcileSavedBlocks(previous, base);
    // Reset/paging replies cross IPC with fresh identities. Reuse equal records
    // so overlapping windows and refreshed history preserve their OnPush inputs.
    const known = direction || replacesTail ? new Map(previous.map(item => [item.id, item])) : undefined;
    const next = new Map(base.map(item => {
      const old = known?.get(item.id);
      return [item.id, old && (old === item || JSON.stringify(old) === JSON.stringify(item)) ? old : item];
    }));
    for (const event of page.events) {
      if (event.type === "item") {
        const old = next.get(event.item.id);
        if (!old || (old !== event.item && JSON.stringify(old) !== JSON.stringify(event.item)))
          next.set(event.item.id, event.item);
      }
      else if (event.type === "delta") {
        const old = next.get(event.id);
        if (old) next.set(event.id, { ...old, text: old.text + event.text });
      }
    }
    const pending = this.pending();
    const records = [...next.values()];
    const receiptIndex = (submission: PendingSubmission | null, start: number) =>
      submission && !older && (!direction || !page.next || start > 0)
        ? records.findIndex((item, index) => index >= start && item.kind === "user" && item.text === submission.text)
        : -1;
    const start = pending ? pendingPromptStart(records, pending) : records.length;
    const deliveredIndex = receiptIndex(pending, start);
    const delivered = records[deliveredIndex];
    const queued = this.pendingQueue();
    const deliveredQueued = records[receiptIndex(queued, queued ? pendingPromptStart(records, queued) : records.length)];
    // Snapshots and history pages already have authoritative order. A late
    // incremental receipt may need to precede output shown under its pending prompt.
    const precedingPrompt = delivered ? promptBefore(records, deliveredIndex) : undefined;
    const reordered = delivered && deliveredIndex > start && !direction && !page.reset &&
      (!precedingPrompt || pending?.knownIds.has(precedingPrompt.id))
      ? [...records.slice(0, start), delivered, ...records.slice(start, deliveredIndex), ...records.slice(deliveredIndex + 1)]
      : records;
    const { records: all, arrivals: queueArrivals } = !direction
      ? this.acceptQueuedDeliveries(page.state, previous, reordered, !page.reset, delivered?.id)
      : { records: reordered, arrivals: new Map<string, string>() };
    const items = retainChatWindow(all, keepsOlder);
    const evicted = all.length > items.length;
    if (keepsOlder && evicted) {
      const contextIds = new Set(all.map(item => item.id));
      this.trailingContext.set(chatTailContext([
        ...all.slice(items.length),
        ...this.trailingContext().filter(item => !contextIds.has(item.id)),
      ]));
    } else if (replacesTail) this.trailingContext.set([]);
    else if (direction === 'following') {
      if (!page.next) this.trailingContext.set([]);
      else {
        // Nothing behind the following cursor can be missing from the gap
        // anymore. Drop context that might have been removed during a rewind.
        const pageIds = new Set(page.items.map(item => item.id));
        this.trailingContext.update(context => {
          let overlap = context.length;
          while (overlap > 0 && !pageIds.has(context[overlap - 1]!.id)) overlap--;
          return overlap ? context.slice(overlap) : context;
        });
      }
    }
    if (delivered || queueArrivals.size || this.turnArrivals().size) {
      // Receipts can arrive with completion. Keep Angular's mounted turn key
      // through that handoff while actions/reviews keep using the durable ID.
      const arrivals = new Map(this.turnArrivals());
      if (delivered && pending) arrivals.set(delivered.id, { renderId: pending.id, sendOrigin: pending.sendOrigin });
      for (const [id, renderId] of queueArrivals) arrivals.set(id, { renderId });
      const retained = new Set([...items, ...this.trailingContext()].map(item => item.id));
      for (const id of arrivals.keys())
        if (!retained.has(id)) arrivals.delete(id);
      this.turnArrivals.set(arrivals);
    }
    if (!direction && wasLoaded && (!page.reset || this.fresh().size)) {
      const known = new Set(previous.map((item) => item.id));
      this.fresh.set(
        new Set(
          items
            .filter(
              (item) =>
                (!page.reset && !known.has(item.id)) ||
                this.fresh().has(item.id),
            )
            .map((item) => item.id),
        ),
      );
    }
    if (direction) this.fresh.update(ids => new Set([...ids].filter(id => items.some(item => item.id === id))));
    // Retain only the prompt owning the first item, even after its actual row
    // is evicted. Context never participates in pagination or delivery receipts.
    const cut = keepsOlder ? 0 : all.length - items.length;
    const prompt = items[0]?.kind === 'user' ? null
      : promptBefore(all, cut)
        ?? (older || (replacesTail && !keepsPrefix) || !previous.length
          ? page.leadingPrompt : this.leadingPrompt());
    const oldPrompt = this.leadingPrompt();
    this.leadingPrompt.set(oldPrompt && prompt && JSON.stringify(oldPrompt) === JSON.stringify(prompt) ? oldPrompt : prompt ?? null);
    this.items.set(items);
    this.state.set(page.state);
    if (!direction) this.cursor = page.cursor;
    if (older) {
      this.before.set(evicted && preserveTail ? items[0]?.id ?? null : page.before);
      if (evicted && keepsOlder) {
        const last = items.at(-1);
        this.next.set(last?.completedTurn?.endId ?? last?.id ?? null);
      }
    } else {
      if (replacesTail && !keepsPrefix) this.before.set(page.before);
      if (evicted) this.before.set(items[0]?.id ?? null);
      this.next.set(page.next ?? null);
    }
    this.historical.set(!!this.next());
    const replacedRows = replacesTail && wasLoaded && previous.some((item, index) => item.id !== items[index]?.id);
    if (direction || evicted || replacedRows)
      this.windowRevision.update(value => value + 1);
    this.reconcileDelivery(page.state, delivered, deliveredQueued);
  }

  private acceptQueuedDeliveries(
    state: SessionChatState, previous: readonly SessionChatItem[], records: readonly SessionChatItem[], incremental: boolean,
    directReceipt?: string,
  ) {
    const deliveries = this.queuedDeliveries();
    if (!deliveries.size && !state.dispatchingPrompts?.length)
      return { records, arrivals: new Map<string, string>() };
    const claimed = new Set(this.turnArrivals().keys());
    if (directReceipt) claimed.add(directReceipt);
    const update = reconcileQueuedDeliveries(deliveries, state, previous, records, incremental, claimed);
    this.queuedDeliveries.set(update.deliveries);
    return update;
  }

  private reconcileDelivery(state: SessionChatState, delivered?: SessionChatItem, deliveredQueued?: SessionChatItem): void {
    const dispatched = (submission: PendingSubmission) => state.dispatchingPrompts?.some(
      item => !submission.knownQueueIds.has(item.id) && item.text === submission.text,
    );
    const pending = this.pending();
    if (
      pending &&
      (delivered || dispatched(pending) ||
        state.queue.some(
          (item) =>
            !pending.knownQueueIds.has(item.id) && item.text === pending.text,
        ))
    ) {
      pending.confirmed = true;
      this.pending.set(null);
    }
    const queued = this.pendingQueue();
    const queueReceipt = queued && state.queue.find(
      item => !queued.knownQueueIds.has(item.id) && item.text === queued.text,
    );
    if (queueReceipt || this.queueRenderIds().size) {
      // Keep the optimistic row mounted: an exit plus a new entry would briefly
      // add an extra row to the composer's measured height.
      const renderIds = new Map(this.queueRenderIds());
      if (queueReceipt && queued) renderIds.set(queueReceipt.id, queued.id);
      const retained = new Set(state.queue.map(item => item.id));
      for (const id of renderIds.keys())
        if (!retained.has(id)) renderIds.delete(id);
      this.queueRenderIds.set(renderIds);
    }
    if (queued && (queueReceipt || deliveredQueued || dispatched(queued))) {
      queued.confirmed = true;
      this.pendingQueue.set(null);
    }
  }

  async submit(submission: ComposerSubmission, writeDraft?: (text: string) => void): Promise<void> {
    if (this.loading() || this.draftRestoring()) return;
    const original = this.draft();
    if (this.historical()) {
      const epoch = this.epoch;
      if (!await this.refresh() || epoch !== this.epoch) return;
    }
    if (
      !this.selection || (!this.state() && !this.offline()) ||
      this.busy() ||
      this.readOnly() ||
      this.uncertain() || this.waitingUncertain() || (!this.offline() && this.waitingPending()) ||
      (!submission.text.trim() && !this.entry.files().length) ||
      this.entry.files().some(file => file.status !== "ready")
    )
      return;
    if (submission.text.length > 64000) {
      this.error.set("Messages can contain up to 64,000 characters.");
      if (!original && !this.draft()) this.setDraft(submission.text);
      return;
    }
    const files = this.entry.files();
    const pins = new Set(files.flatMap(file => file.element && file.marker ? [file.marker] : []));
    const orphan = elementMarkersIn(submission.text).find(marker => !pins.has(marker));
    if (orphan) {
      this.error.set(`${elementMarker(orphan)} doesn’t match an element in this message. Remove it or point at that element again.`); return;
    }
    if (pins.size && !this.state()?.browserElements) { this.error.set('This harness cannot receive element images. Remove the references or choose a supported harness.'); return; }
    const mentions = this.mentions();
    if (mentions.length > 8) {
      this.error.set('Keep up to 8 session mentions before sending.'); return;
    }
    if (mentions.length && !this.state()?.sessionMentions) {
      this.error.set('This backend does not support session mentions. Remove the mentions before sending.'); return;
    }
    const text = [submission.text.trim(), serializeBrowserElements(files.flatMap(file => file.element && file.marker ? [{ reference: file.element, marker: file.marker, attachment: file.name, imageIndex: files.filter(image => image.kind === 'image').findIndex(image => image.id === file.id) + 1 }] : [])), ...files.map(file => `[${file.name.replace(/[[\]\r\n]/g, '_')}](<${file.path}>)`)].filter(Boolean).join('\n\n');
    if (text.length > 64000) { this.error.set('Message and attachments exceed 64,000 characters.'); return; }
    if (this.offline() && this.outbox && this.selection) {
      if (this.outbox.enqueue(this.selection, { type: 'send', text, queue: false, ...(mentions.length ? { sessionIds: mentions.map(mention => Number(mention.id)) } : {}) }, text, null)) {
        if (this.draft() === original) { this.setDraft(''); writeDraft?.(''); }
        this.entry.files.set([]); this.entry.mentions.set([]); this.error.set('');
      } else this.error.set('Up to 20 actions can wait in this window. Remove one before adding another.');
      return;
    }
    const pending = {
      sendOrigin: submission.intent === "send" && !files.length && !mentions.length ? submission.sendOrigin : undefined,
      attachments: files,
      mentions: mentions.map(mention => ({ sessionId: Number(mention.id), title: mention.label })),
      media: files.map((file, index) => ({ id: String(index), path: file.path, caption: file.name.replace(/[[\]\r\n]/g, '_'), kind: file.kind, inline: false })),
      id: "local-" + crypto.randomUUID(),
      confirmed: false,
      text,
      queue: submission.intent === "queue",
      timestamp: new Date().toISOString(),
      knownIds: new Set(this.visibleItems().map(item => item.id)),
      knownQueueIds: new Set(this.state()?.queue.map((item) => item.id) ?? []),
    };
    const entry = this.entry,
      epoch = this.epoch;
    const pendingChannel = pending.queue ? this.pendingQueue : this.pending;
    pendingChannel.set(pending);
    if (entry.beginSend(submission.text, original)) writeDraft?.('');
    entry.files.set([]);
    entry.mentions.set([]);
    const success = await this.perform({
      type: "send",
      text,
      queue: pending.queue,
      ...(mentions.length ? { sessionIds: mentions.map(mention => Number(mention.id)) } : {}),
    });
    if (!success) entry.files.update(current => [...files, ...current]);
    if (!success) entry.mentions.update(current => [...mentions, ...current.filter(item => !mentions.some(mention => mention.id === item.id))]);
    const current = epoch === this.epoch && !this.disposed;
    const restore = !success && (!current || pendingChannel()?.id === pending.id);
    if (restore && current) pendingChannel.set(null);
    entry.finishSend(restore);
    if (restore && current) writeDraft?.(entry.text());
  }
  editPrompt(target: ChatSelection, itemId: string, revision: string, text: string): Promise<boolean> {
    if (target.scopeId !== this.selection?.scopeId || target.taskId !== this.selection.taskId ||
        target.sessionId !== this.selection.sessionId || this.promptEditDisabledReason())
      return Promise.resolve(false);
    return this.perform({ type: 'edit-prompt', itemId, revision, text });
  }

  async perform(action: SessionChatAction): Promise<boolean> {
    const selection = this.selection;
    if (
      !selection ||
      (this.busy() && action.type !== "stop") ||
      this.readOnly() ||
      (action.type === 'edit-prompt' && !!this.promptEditDisabledReason()) ||
      (this.uncertain() && action.type !== "stop")
    )
      return false;
    if (
      action.type === "provider" &&
      (this.state()?.providerLocked !== false ||
        !this.state()?.providers?.some(
          (provider) => provider.id === action.provider,
        ))
    )
      return false;
    if (this.offline()) {
      if (!this.outbox || !['stop', 'answer', 'permission'].includes(action.type)) { this.error.set('This action needs the machine. Nothing was sent.'); return false; }
      const label = action.type === 'stop' ? 'Stop this turn' : action.type === 'answer' ? 'Answer the request' : 'Respond to approval';
      const queued = this.outbox.enqueue(selection, action, label, [...this.items()].reverse().find(item => item.kind === 'user')?.id ?? null);
      if (!queued) this.error.set('The waiting list is full. Nothing was sent.');
      return queued;
    }
    const epoch = this.epoch,
      entry = this.entry,
      commandId = crypto.randomUUID();
    this.commands.set(commandId, action.type);
    entry.uncertain.set(
      "An action was sent from this session. Check its result before trying again.",
    );
    this.busy.set(action.type);
    this.error.set("");
    if (action.type === 'edit-prompt') this.promptEditError.set('');
    const state = this.state();
    const queuedPrompt = action.type === 'steer-queued' ? state?.queue.find(item => item.id === action.id)
      : action.type === 'resume-queue' && state?.phase === 'idle' && !state.canInterrupt ? state.queue[0]
      : undefined;
    if (queuedPrompt) {
      const delivery = queuedDelivery({ ...queuedPrompt, timestamp: new Date().toISOString() }, this.visibleItems(), true);
      this.queuedDeliveries.update(current => new Map(current).set(queuedPrompt.id, delivery));
    }
    if (action.type === "preset-default" || action.type === "save-preset")
      this.defaultChange.set(undefined);
    this.notice.set(
      action.type === "send" || queuedPrompt
        ? "Sending…"
        : action.type === "edit-prompt"
          ? "Resending message…"
        : action.type === "provider"
          ? "Changing harness…"
          : "Updating…",
    );
    const configuration = ["provider", "preset", "save-preset", "preset-default",
      "preset-update", "preset-reorder", "preset-delete", "preset-restore"].includes(action.type);
    if (configuration) this.stopRead();
    const pending = action.type === "send"
      ? (action.queue ? this.pendingQueue() : this.pending())
      : null;
    let result = await this.client.command(selection.scopeId, {
      taskId: selection.taskId,
      sessionId: selection.sessionId,
      action,
    });
    // A durable user/queue receipt is stronger evidence than a lost HTTP reply.
    // Running state or assistant output alone cannot identify this submission.
    const queuedReceipt = queuedPrompt && [...this.turnArrivals().values()].some(arrival => arrival.renderId === `queued-delivery:${queuedPrompt.id}`);
    if (!result.ok && result.error.code === "outcome-unknown" && (pending?.confirmed || queuedReceipt))
      result = { ok: true, value: { accepted: true } };
    if (
      result.ok ||
      (result.error.code !== "outcome-unknown" &&
        result.error.code !== "stale-scope")
    )
      entry.uncertain.set("");
    if (this.disposed || epoch !== this.epoch) return result.ok;
    if (!result.ok || (!configuration && action.type !== 'edit-prompt')) {
      this.commands.delete(commandId);
      this.busy.set(this.commands.values().next().value ?? "");
    }
    if (!result.ok) {
      if (queuedPrompt && this.queuedDeliveries().get(queuedPrompt.id)?.local) {
        const remaining = new Map(this.queuedDeliveries());
        remaining.delete(queuedPrompt.id);
        this.queuedDeliveries.set(remaining);
      }
      this.notice.set("");
      if (action.type === 'edit-prompt') this.promptEditError.set(result.error.message);
      else this.error.set(result.error.message);
      if (
        result.error.code === "outcome-unknown" ||
        result.error.code === "stale-scope"
      ) {
        this.entry.uncertain.set(result.error.message);
        this.checked.set(false);
      }
      if (configuration) {
        this.stopRead();
        void this.load(true);
      }
      if (action.type === 'edit-prompt' && result.error.code === 'outcome-unknown') void this.refresh();
      return false;
    }
    this.notice.set(
      action.type === "send" || action.type === 'edit-prompt' || action.type === 'steer-queued' || action.type === 'resume-queue'
        ? ""
        : action.type === "stop"
          ? "Stop requested"
          : action.type === "provider"
            ? "Harness changed"
            : "Updated",
    );
    this.defaultChange.set(result.value.defaultChange);
    this.presetRemoval.set(result.value.presetRemoval);
    if (configuration || action.type === 'edit-prompt') {
      // Retain the settings surface and its focus while loading the new catalog.
      // Keep writes blocked until authoritative provider state replaces it.
      this.stopRead();
      await this.load(true);
      if (this.disposed || epoch !== this.epoch) return true;
      if (
        action.type === "provider" &&
        this.state()?.provider !== action.provider
      )
        this.state.set(null);
      this.commands.delete(commandId);
      this.busy.set(this.commands.values().next().value ?? "");
    } else if (!this.streamAvailable || (!this.stream && !this.request)) {
      // A confirmed write only invalidates the incremental window. Its follow-up
      // read must not turn a successful send into a loading/error state.
      this.stopRead();
      void this.load(false);
    }
    return true;
  }
  acknowledgeUncertain(): void {
    if (this.checked()) {
      this.entry.acknowledgeSend();
      this.error.set("");
      this.notice.set(
        "Draft retained. Check for an existing message before sending.",
      );
    }
  }
}
