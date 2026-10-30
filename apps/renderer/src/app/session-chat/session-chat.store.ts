import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from "@angular/core";
import type {
  SessionChatAction,
  SessionChatItem,
  SessionChatPage,
  SessionChatState,
  SessionChatTarget,
} from "@elevenex/shared";
import { SessionChatClient } from "../backend/session-chat-client.service";
import type { ChatExchange, ComposerSubmission } from "../conversation";
import { SessionChatDrafts } from "./session-chat-drafts";
import {
  chatExchanges,
  type PendingChatPrompt,
} from "./session-chat-transcript";

interface PendingSubmission extends PendingChatPrompt {
  readonly queue: boolean;
  readonly knownQueueIds: ReadonlySet<string>;
}

export interface ChatSelection extends SessionChatTarget {
  readonly scopeId: string;
}
/** One mounted conversation owns its reads, incremental window and mutation epochs. */
@Injectable()
export class SessionChatStore {
  private readonly client = inject(SessionChatClient);
  private readonly drafts = inject(SessionChatDrafts);
  private selection: ChatSelection | null = null;
  private entry = { text: signal(""), uncertain: signal("") };
  private epoch = 0;
  private readEpoch = 0;
  private cursor: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private request: string | undefined;
  private disposed = false;
  private readonly commands = new Map<string, string>();
  readonly state = signal<SessionChatState | null>(null);
  readonly items = signal<readonly SessionChatItem[]>([]);
  readonly fresh = signal<ReadonlySet<string>>(new Set());
  readonly loading = signal(true);
  readonly error = signal("");
  readonly notice = signal("");
  readonly busy = signal("");
  readonly readOnly = signal(false);
  readonly historical = signal(false);
  readonly before = signal<string | null>(null);
  readonly draft = signal("");
  readonly uncertain = signal("");
  readonly checked = signal(false);
  private readonly pending = signal<PendingSubmission | null>(null);
  private readonly pendingQueue = signal<PendingSubmission | null>(null);
  readonly running = computed(
    () =>
      this.state()?.phase === "running" ||
      this.state()?.phase === "waiting" ||
      (!!this.pending() && !this.pending()?.queue),
  );
  readonly queue = computed(() => {
    const pending = this.pendingQueue(),
      queue = this.state()?.queue ?? [];
    return pending ? [...queue, { id: pending.id, text: pending.text }] : queue;
  });
  readonly exchanges = computed<readonly ChatExchange[]>(() => {
    const pending = this.pending();
    return chatExchanges(
      this.items(),
      this.state(),
      this.fresh(),
      pending && !pending.queue ? pending : undefined,
    ).map((exchange) =>
      exchange.id === pending?.id
        ? {
            ...exchange,
            isNew: true,
            status: this.running() ? "live" : exchange.status,
          }
        : exchange,
    );
  });
  readonly empty = computed(() => !this.exchanges().length && !this.running());

  constructor() {
    const visible = () => {
      if (document.hidden) this.stopRead();
      else if (this.selection && !this.historical()) void this.load(false);
    };
    document.addEventListener("visibilitychange", visible);
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true;
      this.epoch++;
      this.stopRead();
      document.removeEventListener("visibilitychange", visible);
    });
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
    this.stopRead();
    this.epoch++;
    this.selection = selection;
    this.entry = this.drafts.entry(selection.scopeId, selection.sessionId);
    this.readOnly.set(readOnly);
    this.draft.set(this.entry.text());
    this.uncertain.set(this.entry.uncertain());
    this.pending.set(null);
    this.pendingQueue.set(null);
    this.items.set([]);
    this.state.set(null);
    this.fresh.set(new Set());
    this.error.set("");
    this.notice.set("");
    this.commands.clear();
    this.busy.set("");
    this.historical.set(false);
    this.checked.set(false);
    this.cursor = undefined;
    void this.load(true);
  }
  setDraft(value: string): void {
    this.draft.set(value);
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
    if (!selection || this.disposed || document.hidden) return;
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
      this.error.set("");
      this.accept(result.value, !!before);
      if (this.uncertain()) this.checked.set(true);
    } else
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
    )
      this.pending.set(null);
    const queued = this.pendingQueue();
    if (
      queued &&
      (page.state.queue.some(
        (item) =>
          !queued.knownQueueIds.has(item.id) && item.text === queued.text,
      ) ||
        items.some(
          (item) =>
            item.kind === "user" &&
            !queued.knownIds.has(item.id) &&
            item.text === queued.text,
        ))
    )
      this.pendingQueue.set(null);
  }

  async submit(submission: ComposerSubmission): Promise<void> {
    if (
      this.busy() ||
      this.readOnly() ||
      this.historical() ||
      this.uncertain() ||
      !submission.text.trim()
    )
      return;
    if (submission.text.length > 64000) {
      this.error.set("Messages can contain up to 64,000 characters.");
      this.setDraft(submission.text);
      return;
    }
    const pending = {
      id: "local-" + crypto.randomUUID(),
      text: submission.text,
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
    const success = await this.perform({
      type: "send",
      text: submission.text,
      queue: pending.queue,
    });
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
    const epoch = this.epoch,
      entry = this.entry,
      commandId = crypto.randomUUID();
    this.commands.set(commandId, action.type);
    entry.uncertain.set(
      "An action was sent from this session. Check its result before trying again.",
    );
    this.busy.set(action.type);
    this.error.set("");
    this.notice.set(
      action.type === "send"
        ? "Sending…"
        : action.type === "provider"
          ? "Changing harness…"
          : "Updating…",
    );
    if (action.type === "provider") this.stopRead();
    const result = await this.client.command(selection.scopeId, {
      taskId: selection.taskId,
      sessionId: selection.sessionId,
      action,
    });
    if (
      result.ok ||
      (result.error.code !== "outcome-unknown" &&
        result.error.code !== "stale-scope")
    )
      entry.uncertain.set("");
    if (this.disposed || epoch !== this.epoch) return result.ok;
    if (!result.ok || action.type !== "provider") {
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
        this.uncertain.set(result.error.message);
        this.entry.uncertain.set(result.error.message);
        this.checked.set(false);
      }
      if (action.type === "provider") {
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
    if (action.type === "provider") {
      this.cursor = undefined;
      this.items.set([]);
      this.before.set(null);
      this.fresh.set(new Set());
    }
    // Explicitly reconcile writes; reconnect and read retries never replay them.
    this.stopRead();
    if (action.type === "provider") {
      // Retain the settings surface and its focus while loading the new catalog.
      // Keep writes blocked until authoritative provider state replaces it.
      await this.load(true);
      if (this.disposed || epoch !== this.epoch) return true;
      if (this.state()?.provider !== action.provider) this.state.set(null);
      this.commands.delete(commandId);
      this.busy.set(this.commands.values().next().value ?? "");
    } else void this.load(true);
    return true;
  }
  acknowledgeUncertain(): void {
    if (this.checked()) {
      this.uncertain.set("");
      this.entry.uncertain.set("");
      this.error.set("");
      this.notice.set(
        "Draft retained. Check for an existing message before sending.",
      );
    }
  }
}
