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
import { SessionChatClient } from "../backend/session-chat-client.service";
import type { ChatExchange, ComposerSubmission, MessageSendOrigin, ConversationMention, QueuedMessage, WaitingMessage } from "../conversation";
import { SessionChatDrafts, type AttachmentDraft, type StartingSession } from "./session-chat-drafts";
import {
  chatExchanges,
  type PendingChatPrompt,
} from "./session-chat-transcript";

interface PendingSubmission extends PendingChatPrompt {
  readonly sendOrigin?: MessageSendOrigin;
  readonly queue: boolean;
  readonly knownQueueIds: ReadonlySet<string>;
  confirmed: boolean;
}

export interface ChatSelection extends SessionChatTarget {
  readonly scopeId: string;
}
/** One mounted conversation owns its reads, incremental window and mutation epochs. */
@Injectable()
export class SessionChatStore {
  private readonly client = inject(SessionChatClient);
  private readonly drafts = inject(SessionChatDrafts);
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
  private request: string | undefined;
  private disposed = false;
  private readonly commands = new Map<string, string>();
  // Replies cross IPC with new object identities even on an idle heartbeat.
  // Keep unchanged inputs stable so polling does not rebuild the conversation.
  readonly state = signal<SessionChatState | null>(null, { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  readonly items = signal<readonly SessionChatItem[]>([], { equal: (a, b) => a.length === b.length && a.every((item, index) => item === b[index]) });
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
  readonly draft = computed(() => this.activeEntry().text());
  readonly mentions = computed(() => this.activeEntry().mentions());
  addMention(mention: ConversationMention): void {
    if (!this.state()?.sessionMentions || mention.kind !== 'session' || this.readOnly() || this.historical() || this.busy() || this.uncertain()) return;
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
  private readonly turnArrivals = signal<ReadonlyMap<string, {
    readonly renderId: string;
    readonly sendOrigin?: MessageSendOrigin;
  }>>(new Map());
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
  readonly exchanges = computed<readonly ChatExchange[]>(() => {
    const pending = this.pending();
    return chatExchanges(
      this.items(),
      this.state(),
      this.fresh(),
      pending && !pending.queue ? pending : undefined,
    ).map((exchange): ChatExchange => {
      const arrival = this.turnArrivals().get(exchange.id);
      if (exchange.id === pending?.id)
        return {
          ...exchange,
          isNew: true,
          sendOrigin: pending.sendOrigin,
          status: this.running() ? "live" : exchange.status,
        };
      return arrival ? { ...exchange, ...arrival, isNew: true } : exchange;
    });
  });
  readonly empty = computed(() => !this.exchanges().length && !this.running());

  constructor() {
    let wasPaused: boolean | undefined;
    effect(() => {
      const paused = this.offline() || !this.active();
      const resumed = wasPaused === true && !paused;
      wasPaused = paused;
      untracked(() => { if (paused) { this.stopRead(); this.loading.set(false); } else if (resumed && this.selection && !this.request && !this.historical()) void this.load(false); });
    });
    const visible = () => {
      if (document.hidden) this.stopRead();
      else if (this.selection && !this.historical()) void this.load(false);
    };
    document.addEventListener("visibilitychange", visible);
    inject(DestroyRef).onDestroy(() => {
      this.outbox?.setEditing(null);
      this.remember();
      this.disposed = true;
      this.epoch++;
      this.stopRead();
      document.removeEventListener("visibilitychange", visible);
    });
  }

  openDraft(starting: StartingSession): void {
    if (this.startingId === starting.id && this.entry === starting.draft) { this.selectedScope.set(starting.scopeId); return; }
    this.outbox?.setEditing(null);
    this.remember(); this.stopRead(); this.epoch++;
    this.selection = null; this.startingId = starting.id; this.starting.set(true); this.compactStart.set(false);
    this.selectedTarget.set(''); this.selectedScope.set(starting.scopeId);
    this.entry = starting.draft; this.activeEntry.set(this.entry);
    this.state.set(null); this.items.set([]); this.before.set(null); this.cursor = undefined;
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
    this.readOnly.set(readOnly);
    this.pending.set(null);
    this.pendingQueue.set(null);
    if (!recovery && !startingHandoff) { this.viewRevision.update(value => value + 1); this.turnArrivals.set(new Map()); this.queueRenderIds.set(new Map()); }
    const cached = this.drafts.snapshot(selection.sessionId);
    if (!recovery) { this.items.set(cached?.items ?? []); this.state.set(cached?.state ?? null); }
    this.before.set(recovery ? previousBefore : cached?.before ?? null);
    if (!recovery) this.fresh.set(new Set());
    this.error.set("");
    this.notice.set("");
    this.defaultChange.set(undefined);
    this.commands.clear();
    this.busy.set("");
    this.historical.set(recovery && historical);
    this.checked.set(false);
    this.cursor = recovery ? previousCursor : undefined;
    if (recovery && historical) this.loading.set(false);
    else void this.load(!recovery);
  }
  private remember(): void {
    const state = this.state();
    if (this.selection && state) this.drafts.remember(this.selection.sessionId, { items: this.items(), state, cursor: this.cursor, before: this.before() });
  }
  setDraft(value: string): void {
    this.entry.text.set(value);
  }
  private stopRead(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.readEpoch++;
    if (this.request && this.selection)
      this.client.cancel(this.selection.scopeId, this.request);
    this.request = undefined;
  }
  async refresh(): Promise<void> {
    this.historical.set(false);
    this.stopRead();
    await this.load(true);
  }
  async older(): Promise<void> {
    if (!this.before() || this.loading()) return;
    this.stopRead();
    this.historical.set(true);
    await this.load(false, this.before()!);
  }
  private async load(reset: boolean, before?: string): Promise<void> {
    const selection = this.selection;
    if (!selection || this.request || this.disposed || document.hidden || this.offline() || !this.active()) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const epoch = this.epoch,
      readEpoch = ++this.readEpoch,
      requestId = crypto.randomUUID();
    this.request = requestId;
    if (reset || before) this.loading.set(true);
    const result = await this.client.read(selection.scopeId, {
      taskId: selection.taskId,
      sessionId: selection.sessionId,
      requestId,
      ...(before
        ? { before }
        : !reset && this.cursor
          ? { after: this.cursor }
          : {}),
    });
    if (this.disposed || epoch !== this.epoch || readEpoch !== this.readEpoch)
      return;
    this.request = undefined;
    this.loading.set(false);
    if (result.ok) {
      if (this.starting()) this.compactStart.set(!!this.draft().trim());
      this.starting.set(false);
      this.error.set("");
      this.accept(result.value, !!before);
      if (this.uncertain()) this.checked.set(true);
    } else if (reset || before || !this.state() || result.error.status === 404)
      this.error.set(
        result.error.status === 404
          ? "Chat is unavailable on this machine. Update its engine, then reconnect."
          : result.error.message,
      );
    if (
      !this.historical() &&
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
  }
  private accept(page: SessionChatPage, older: boolean): void {
    const previous = this.items(),
      wasLoaded = !!this.cursor;
    const next = new Map<string, SessionChatItem>(
      (page.reset || older ? page.items : previous).map((item) => [
        item.id,
        item,
      ]),
    );
    for (const event of page.events) {
      if (event.type === "item") next.set(event.item.id, event.item);
      else if (event.type === "delta") {
        const old = next.get(event.id);
        if (old) next.set(event.id, { ...old, text: old.text + event.text });
      }
    }
    const pending = this.pending();
    const delivered =
      pending && !pending.queue
        ? [...next.values()].find(
            (item) =>
              item.kind === "user" &&
              !pending.knownIds.has(item.id) &&
              item.text === pending.text,
          )
        : undefined;
    // A late receipt must precede output already shown under its optimistic turn.
    const all =
      delivered && pending
        ? [
            ...[...next.values()].filter((item) =>
              pending.knownIds.has(item.id),
            ),
            delivered,
            ...[...next.values()].filter(
              (item) =>
                !pending.knownIds.has(item.id) && item.id !== delivered.id,
            ),
          ]
        : [...next.values()];
    const items = all.slice(-320);
    if (delivered || this.turnArrivals().size) {
      // Receipts can arrive with completion. Keep Angular's mounted turn key
      // through that handoff while actions/reviews keep using the durable ID.
      const arrivals = new Map(this.turnArrivals());
      if (delivered && pending) arrivals.set(delivered.id, { renderId: pending.id, sendOrigin: pending.sendOrigin });
      const retained = new Set(items.map(item => item.id));
      for (const id of arrivals.keys())
        if (!retained.has(id)) arrivals.delete(id);
      this.turnArrivals.set(arrivals);
    }
    if (!older && wasLoaded) {
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
    this.items.set(items);
    this.state.set(page.state);
    if (!older) this.cursor = page.cursor;
    if (page.reset || older) this.before.set(page.before);
    if (all.length > 320) this.before.set(items[0]?.id ?? null);
    if (
      pending &&
      (items.some(
        (item) =>
          item.kind === "user" &&
          !pending.knownIds.has(item.id) &&
          item.text === pending.text,
      ) ||
        page.state.queue.some(
          (item) =>
            !pending.knownQueueIds.has(item.id) && item.text === pending.text,
        ))
    ) {
      pending.confirmed = true;
      this.pending.set(null);
    }
    const queued = this.pendingQueue();
    const queueReceipt = queued && page.state.queue.find(
      item => !queued.knownQueueIds.has(item.id) && item.text === queued.text,
    );
    if (queueReceipt || this.queueRenderIds().size) {
      // Keep the optimistic row mounted: an exit plus a new entry would briefly
      // add an extra row to the composer's measured height.
      const renderIds = new Map(this.queueRenderIds());
      if (queueReceipt && queued) renderIds.set(queueReceipt.id, queued.id);
      const retained = new Set(page.state.queue.map(item => item.id));
      for (const id of renderIds.keys())
        if (!retained.has(id)) renderIds.delete(id);
      this.queueRenderIds.set(renderIds);
    }
    if (
      queued &&
      (queueReceipt ||
        items.some(
          (item) =>
            item.kind === "user" &&
            !queued.knownIds.has(item.id) &&
            item.text === queued.text,
        ))
    ) {
      queued.confirmed = true;
      this.pendingQueue.set(null);
    }
  }

  async submit(submission: ComposerSubmission): Promise<void> {
    if (
      !this.selection || (!this.state() && !this.offline()) ||
      this.busy() ||
      this.readOnly() ||
      this.historical() ||
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
    const mentions = this.mentions();
    if (mentions.length > 8) {
      this.error.set('Keep up to 8 session mentions before sending.'); return;
    }
    if (mentions.length && !this.state()?.sessionMentions) {
      this.error.set('This backend does not support session mentions. Remove the mentions before sending.'); return;
    }
    const text = [submission.text.trim(), ...files.map(file => `[${file.name.replace(/[[\]\r\n]/g, '_')}](<${file.path}>)`)].filter(Boolean).join('\n\n');
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
      knownIds: new Set(this.items().map((item) => item.id)),
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
        this.historical() ||
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
