import { elementMarker, elementMarkersIn, serializeBrowserElements } from '@elevenex/shared';
import {
  DestroyRef,
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
import { SessionChatTurnWork, SessionChatWorkCache } from './session-chat-turn-work';
import { SessionChatToolCache, SessionChatToolDetails } from './session-chat-tool-details';
import { SessionChatClient } from "../backend/session-chat-client.service";
import type { ChatExchange, ComposerSubmission, MessageSendOrigin, ConversationMention, QueuedMessage, WaitingMessage } from "../conversation";
import { SessionChatDrafts, type AttachmentDraft, type StartingSession } from "./session-chat-drafts";
import {
  ChatTranscriptProjection,
  pendingPromptStart,
  type PendingChatPrompt,
} from "./session-chat-transcript";

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
  readonly work = new SessionChatTurnWork(this.client, inject(SessionChatWorkCache));
  readonly tools = new SessionChatToolDetails(this.client, inject(SessionChatToolCache), () => { void this.refresh(); });
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
  private entry = { text: signal(""), uncertain: signal(""), files: signal<readonly AttachmentDraft[]>([]), mentions: signal<readonly ConversationMention[]>([]) };
  private readonly activeEntry = signal(this.entry);
  private epoch = 0;
  private readEpoch = 0;
  private cursor: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private slowOpenTimer: ReturnType<typeof setTimeout> | undefined;
  private request: string | undefined;
  private requestMode: 'window' | 'progressive' | undefined;
  private disposed = false;
  private seenRequest: string | undefined;
  private readonly commands = new Map<string, string>();
  // Replies cross IPC with new object identities even on an idle heartbeat.
  // Keep unchanged inputs stable so polling does not rebuild the conversation.
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
  readonly defaultChange =
    signal<SessionChatCommandReply["defaultChange"]>(undefined);
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
  // Keep local entry identity and source through a receipt that beats first paint.
  // Pruned with the bounded transcript and cleared on selection changes.
  private readonly turnArrivals = signal<ReadonlyMap<string, TurnArrival>>(new Map());
  private readonly decoratedTurns = new WeakMap<ChatExchange, {
    readonly arrival?: TurnArrival;
    readonly pending: PendingSubmission | null;
    readonly exchange: ChatExchange;
  }>();
  private readonly queueRenderIds = signal<ReadonlyMap<string, string>>(new Map());
  readonly running = computed(
    () =>
      this.state()?.phase === "running" ||
      this.state()?.phase === "waiting" ||
      (!!this.pending() && !this.pending()?.queue),
  );
  readonly queue = computed<readonly QueuedMessage[]>(() => {
    const pending = this.pendingQueue(),
      queue = (this.state()?.queue ?? []).map((item): QueuedMessage => {
        const renderId = this.queueRenderIds().get(item.id);
        return renderId ? { ...item, renderId } : item;
      });
    return pending ? [...queue, { id: pending.id, text: pending.text }] : queue;
  });
  readonly visibleItems = computed<readonly SessionChatItem[]>(() => {
    const leadingPrompt = this.leadingPrompt();
    const items = this.items();
    const context = this.trailingContext();
    const leading = leadingPrompt && items.length > 0 && items[0]?.kind !== 'user'
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
      const details = entry?.revision === item.completedTurn.revision ? entry.page?.items ?? [] : [];
      return [item, ...details, ...item.completedTurn.reply];
    });
  }, { equal: (a, b) => a.length === b.length && a.every((item, index) => item === b[index]) });
  readonly exchanges = computed<readonly ChatExchange[]>(() => {
    const pending = this.pending();
    const items = this.visibleItems();
    // A distant history window may no longer contain the send boundary.
    const showPending = pending && (!this.historical() || pendingPromptStart(items, pending) > 0);
    const exchanges = this.transcript.project(
      items,
      this.state(),
      this.fresh(),
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
        if (this.request && this.requestMode === 'window' && !this.state()) {
          this.stopRead();
          void this.load(true);
        }
      });
    });
    effect(() => {
      const items = this.visibleItems();
      const available = this.active() && !this.offline() && !document.hidden;
      untracked(() => {
        this.work.sync(items, available);
        this.tools.setAvailable(available);
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
        this.work.sync(this.visibleItems(), available);
        this.tools.setAvailable(available);
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
    this.fresh.set(new Set()); this.error.set(''); this.notice.set(''); this.busy.set(''); this.checked.set(false);
    this.defaultChange.set(undefined); this.commands.clear(); this.readOnly.set(false); this.historical.set(false); this.loading.set(false);
    this.viewRevision.update(value => value + 1);
  }

  open(selection: ChatSelection, readOnly: boolean): void {
    if (
      this.selection?.scopeId === selection.scopeId &&
      this.selection.sessionId === selection.sessionId &&
      this.selection.taskId === selection.taskId
    ) {
      const changed = this.readOnly() !== readOnly;
      this.readOnly.set(readOnly);
      if (changed) {
        this.stopRead();
        void this.load(true);
      }
      return;
    }
    const startingHandoff = !!this.startingId && this.entry === this.drafts.entry(selection.scopeId, selection.sessionId);
    this.startingId = null;
    if (!startingHandoff) { this.starting.set(false); this.compactStart.set(false); }
    this.outbox?.setEditing(null);
    this.remember();
    const sameSession = this.selection?.taskId === selection.taskId && this.selection.sessionId === selection.sessionId;
    const previousEntry = this.entry, previousCursor = this.cursor, previousBefore = this.before(), historical = this.historical();
    this.stopRead();
    this.epoch++;
    this.selection = selection;
    this.selectedTarget.set(`${selection.taskId}/${selection.sessionId}`);
    this.selectedScope.set(selection.scopeId);
    this.entry = this.drafts.entry(selection.scopeId, selection.sessionId);
    this.activeEntry.set(this.entry);
    const recovery = sameSession && previousEntry === this.entry;
    this.work.select(selection, recovery);
    this.tools.select(selection);
    if (!recovery) this.transcript.clear();
    this.readOnly.set(readOnly);
    this.pending.set(null);
    this.pendingQueue.set(null);
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
      this.drafts.remember(this.selection.sessionId, { items: this.items(), leadingPrompt: this.leadingPrompt(), state, cursor: this.cursor, before: this.before() });
  }
  setDraft(value: string): void {
    this.entry.text.set(value);
  }
  private stopRead(): void {
    clearTimeout(this.timer);
    clearTimeout(this.slowOpenTimer);
    this.slowOpenTimer = undefined;
    this.timer = undefined;
    this.readEpoch++;
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
  async older(): Promise<void> {
    if (!this.before() || this.loading() || this.historyLoading()) return;
    this.stopRead();
    await this.load(false, this.before()!, "before");
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
  private async load(reset: boolean, position?: string, direction?: "before" | "following"): Promise<boolean> {
    const selection = this.selection;
    if (!selection || this.request || this.disposed || document.hidden || this.offline() || !this.active()) return false;
    clearTimeout(this.timer);
    this.timer = undefined;
    const epoch = this.epoch,
      readEpoch = ++this.readEpoch,
      requestId = crypto.randomUUID();
    this.request = requestId;
    const profile = this.loadingPolicy.profile();
    this.requestMode = profile.loadingMode;
    if (reset || !this.state()) this.loading.set(true);
    if (direction) { this.historyLoading.set(true); this.historyError.set(""); }
    // Only time an uncached opening, never an idle 8s long poll or history read.
    // Keep the smaller-page choice for this app connection; it must not oscillate
    // or let the cancelled larger response overwrite the replacement window.
    if (!this.state() && !this.progressiveLoading()) {
      this.slowOpenTimer = setTimeout(() => {
        if (this.disposed || epoch !== this.epoch || readEpoch !== this.readEpoch ||
            document.hidden || this.offline() || !this.active()) return;
        if (!this.loadingPolicy.enableProgressive(selection.scopeId)) return;
        this.stopRead();
        void this.load(reset, position, direction);
      }, SESSION_CHAT_SLOW_OPEN_MS);
    }
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
      if (this.starting()) this.compactStart.set(!!this.draft().trim());
      this.starting.set(false);
      this.error.set("");
      this.supportsFollowing = result.value.next !== undefined;
      if (this.historical() && !direction && !reset) {
        // Keep runtime state current without replacing the history being read.
        this.state.set(result.value.state);
        this.cursor = result.value.cursor;
      } else this.accept(result.value, direction, !reset);
      if (this.uncertain()) this.checked.set(true);
    } else if (direction) this.historyError.set(result.error.message);
    else if (reset || !this.state() || result.error.status === 404)
      this.error.set(
        result.error.status === 404
          ? "Chat is unavailable on this machine. Update its engine, then reconnect."
          : result.error.message,
      );
    if (
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
  private accept(page: SessionChatPage, direction?: "before" | "following", incremental = false): void {
    const previous = this.items();
    if (!direction && !page.reset && !page.events.length) {
      this.state.set(page.state);
      this.cursor = page.cursor;
      this.reconcileDelivery(page.state);
      return;
    }
    const older = direction === "before";
    const wasLoaded = !!this.cursor;
    const replacesTail = !direction && page.reset;
    // A reset is authoritative from its first row onward. A matching first
    // row proves where a previously loaded prefix joins the new page.
    const sharedStart = replacesTail && incremental && page.before
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
    const all = delivered && deliveredIndex > start && !direction && !page.reset &&
      (!precedingPrompt || pending?.knownIds.has(precedingPrompt.id))
      ? [...records.slice(0, start), delivered, ...records.slice(start, deliveredIndex), ...records.slice(deliveredIndex + 1)]
      : records;
    const items = retainChatWindow(all, older);
    const evicted = all.length > items.length;
    if (older && evicted) {
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
    if (delivered || this.turnArrivals().size) {
      // Receipts can arrive with completion. Keep Angular's mounted turn key
      // through that handoff while actions/reviews keep using the durable ID.
      const arrivals = new Map(this.turnArrivals());
      if (delivered && pending) arrivals.set(delivered.id, { renderId: pending.id, sendOrigin: pending.sendOrigin });
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
    const cut = older ? 0 : all.length - items.length;
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
      this.before.set(page.before);
      if (evicted) {
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

  private reconcileDelivery(state: SessionChatState, delivered?: SessionChatItem, deliveredQueued?: SessionChatItem): void {
    const pending = this.pending();
    if (
      pending &&
      (delivered ||
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
    if (queued && (queueReceipt || deliveredQueued)) {
      queued.confirmed = true;
      this.pendingQueue.set(null);
    }
  }

  async submit(submission: ComposerSubmission): Promise<void> {
    if (this.loading()) return;
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
      this.setDraft(submission.text);
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
        this.setDraft(''); this.entry.files.set([]); this.entry.mentions.set([]); this.error.set('');
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
    this.setDraft("");
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
    if (epoch !== this.epoch || this.disposed) {
      if (!success)
        entry.text.set(
          entry.text()
            ? submission.text + "\n\n" + entry.text()
            : submission.text,
        );
      return;
    }
    if (!success && pendingChannel()?.id === pending.id) {
      pendingChannel.set(null);
      this.setDraft(
        this.draft()
          ? submission.text + "\n\n" + this.draft()
          : submission.text,
      );
    }
  }
  async perform(action: SessionChatAction): Promise<boolean> {
    const selection = this.selection;
    if (
      !selection ||
      (this.busy() && action.type !== "stop") ||
      this.readOnly() ||
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
    if (action.type === "preset-default" || action.type === "save-preset")
      this.defaultChange.set(undefined);
    this.notice.set(
      action.type === "send"
        ? "Sending…"
        : action.type === "provider"
          ? "Changing harness…"
          : "Updating…",
    );
    if (
      ["provider", "preset", "save-preset", "preset-default"].includes(
        action.type,
      )
    )
      this.stopRead();
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
    if (!result.ok && result.error.code === "outcome-unknown" && pending?.confirmed)
      result = { ok: true, value: { accepted: true } };
    if (
      result.ok ||
      (result.error.code !== "outcome-unknown" &&
        result.error.code !== "stale-scope")
    )
      entry.uncertain.set("");
    if (this.disposed || epoch !== this.epoch) return result.ok;
    const configuration = [
      "provider",
      "preset",
      "save-preset",
      "preset-default",
    ].includes(action.type);
    if (!result.ok || !configuration) {
      this.commands.delete(commandId);
      this.busy.set(this.commands.values().next().value ?? "");
    }
    if (!result.ok) {
      this.notice.set("");
      this.error.set(result.error.message);
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
      return false;
    }
    this.notice.set(
      action.type === "send"
        ? ""
        : action.type === "stop"
          ? "Stop requested"
          : action.type === "provider"
            ? "Harness changed"
            : "Updated",
    );
    this.defaultChange.set(result.value.defaultChange);
    if (configuration) {
      this.cursor = undefined;
      this.items.set([]);
      this.before.set(null);
      this.fresh.set(new Set());
    }
    // Explicitly reconcile writes; reconnect and read retries never replay them.
    this.stopRead();
    if (configuration) {
      // Retain the settings surface and its focus while loading the new catalog.
      // Keep writes blocked until authoritative provider state replaces it.
      await this.load(true);
      if (this.disposed || epoch !== this.epoch) return true;
      if (
        action.type === "provider" &&
        this.state()?.provider !== action.provider
      )
        this.state.set(null);
      this.commands.delete(commandId);
      this.busy.set(this.commands.values().next().value ?? "");
    } else {
      // A confirmed write only invalidates the incremental window. Its follow-up
      // read must not turn a successful send into a loading/error state.
      void this.load(false);
    }
    return true;
  }
  acknowledgeUncertain(): void {
    if (this.checked()) {
      this.entry.uncertain.set("");
      this.error.set("");
      this.notice.set(
        "Draft retained. Check for an existing message before sending.",
      );
    }
  }
}
