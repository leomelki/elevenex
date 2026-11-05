import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from "@angular/core";
import type {
  BackendResult,
  TaskTerminal,
  TaskTerminalList,
  TaskTerminalOutput,
} from "@elevenex/shared";
import {
  BackendClientService,
  ELEVENEX_BRIDGE,
} from "../backend/backend-client.service";

export interface TerminalSelection {
  readonly scopeId: string;
  readonly taskId: number;
}
/** Task-owned metadata. Process lifetime is backend-owned; this owner never starts on selection/recovery. */
@Injectable()
export class TaskTerminalStore {
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  private readonly backend = inject(BackendClientService);
  readonly selection = signal<TerminalSelection | null>(null);
  readonly snapshot = signal<TaskTerminalList | null>(null);
  readonly active = signal<number | null>(null);
  readonly error = signal("");
  readonly busy = signal(false);
  readonly loading = signal(false);
  readonly current = computed(
    () =>
      this.snapshot()?.terminals.find((row) => row.id === this.active()) ??
      null,
  );
  readonly connected = computed(
    () =>
      !!this.selection() &&
      this.backend.state().scope?.id === this.selection()?.scopeId,
  );
  readonly seen = signal<ReadonlyMap<number, number>>(new Map());
  private readonly cache = new Map<
    number,
    {
      snapshot: TaskTerminalList;
      active: number | null;
      seen: ReadonlyMap<number, number>;
    }
  >();
  private revision = 0;
  private readRevision = 0;
  private readonly closing = new Set<string>();
  private lastReadError: string | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true;
      this.revision++;
      clearTimeout(this.timer);
      this.cache.clear();
      this.closing.clear();
    });
  }
  reset(): void {
    this.select(null);
    this.cache.clear();
  }
  select(selection: TerminalSelection | null): void {
    const previous = this.selection();
    if (
      previous?.scopeId === selection?.scopeId &&
      previous?.taskId === selection?.taskId
    )
      return;
    if (previous && this.snapshot()) {
      this.cache.delete(previous.taskId);
      this.cache.set(previous.taskId, {
        snapshot: this.snapshot()!,
        active: this.active(),
        seen: this.seen(),
      });
    }
    while (this.cache.size > 4)
      this.cache.delete(this.cache.keys().next().value!);
    this.revision++;
    clearTimeout(this.timer);
    this.selection.set(selection);
    this.busy.set(false);
    this.error.set("");
    this.lastReadError = null;
    const cached = selection ? this.cache.get(selection.taskId) : undefined;
    this.snapshot.set(cached?.snapshot ?? null);
    this.active.set(cached?.active ?? null);
    this.seen.set(cached?.seen ?? new Map());
    if (selection) void this.refreshLoop(this.revision);
  }
  private currentSelection(
    target: TerminalSelection,
    revision: number,
  ): boolean {
    return (
      !this.disposed &&
      revision === this.revision &&
      this.connected() &&
      this.selection()?.scopeId === target.scopeId &&
      this.selection()?.taskId === target.taskId
    );
  }
  async refresh(): Promise<boolean> {
    const target = this.selection(),
      revision = this.revision,
      readRevision = ++this.readRevision;
    if (!target || !this.connected()) return false;
    this.loading.set(!this.snapshot());
    try {
      const result = await this.bridge.taskTerminalList(
        target.scopeId,
        target.taskId,
      );
      if (
        !this.currentSelection(target, revision) ||
        readRevision !== this.readRevision
      ) return false;
      if (result.ok) {
        this.readRecovered();
        const terminals = result.value.terminals.filter(
          (row) => !this.closing.has(this.closeKey(target, row.id)),
        );
        this.resetSeenForGeneration(terminals, true);
        this.snapshot.set({ ...result.value, terminals });
        if (!terminals.some((row) => row.id === this.active()))
          this.active.set(terminals[0]?.id ?? null);
        return true;
      } else
        this.readFailed(
          result.error.status === 404
            ? "This engine does not support task terminals. Update the engine to continue."
            : result.error.message,
        );
    } catch {
      if (
        this.currentSelection(target, revision) &&
        readRevision === this.readRevision
      )
        this.readFailed("Could not load terminals. Reconnect to try again.");
    } finally {
      if (revision === this.revision && readRevision === this.readRevision)
        this.loading.set(false);
    }
    return false;
  }
  private async refreshLoop(revision: number): Promise<void> {
    await this.refresh();
    if (!this.disposed && revision === this.revision)
      this.timer = setTimeout(() => void this.refreshLoop(revision), 1800);
  }
  async create(scriptId?: string, shellIntegration = true): Promise<void> {
    const target = this.selection(),
      revision = this.revision;
    if (!target || !this.connected() || this.busy()) return;
    this.busy.set(true);
    this.error.set("");
    try {
      const reply = await this.bridge.taskTerminalCreate(target.scopeId, {
        taskId: target.taskId,
        ...(scriptId ? { scriptId } : {}),
        ...(shellIntegration ? {} : { shellIntegration: false }),
      });
      if (!this.currentSelection(target, revision)) return;
      if (reply.ok) {
        await this.refresh();
        if (this.currentSelection(target, revision))
          this.active.set(reply.value.id);
      } else {
        this.error.set(
          reply.error.code === "outcome-unknown"
            ? "Startup may have completed. Inspect the refreshed tabs before creating another terminal."
            : reply.error.message,
        );
        await this.refresh();
      }
    } catch {
      if (this.currentSelection(target, revision)) {
        this.error.set(
          "Startup outcome is unknown. Inspect the refreshed tabs before creating another terminal.",
        );
        await this.refresh();
      }
    } finally {
      if (revision === this.revision) this.busy.set(false);
    }
  }
  async close(id: number): Promise<void> {
    const target = this.selection(),
      snapshot = this.snapshot(),
      revision = this.revision;
    if (!target || !snapshot || !this.connected()) return;
    const index = snapshot.terminals.findIndex((row) => row.id === id);
    const key = this.closeKey(target, id);
    if (index < 0 || this.closing.has(key)) return;

    // Closing a process can take seconds. Detach its UI now without locking other tabs.
    this.closing.add(key);
    const terminals = snapshot.terminals.filter((row) => row.id !== id);
    this.snapshot.set({ ...snapshot, terminals });
    if (this.active() === id)
      this.active.set(terminals[Math.min(index, terminals.length - 1)]?.id ?? null);
    const seen = new Map(this.seen());
    seen.delete(id);
    this.seen.set(seen);
    this.error.set("");
    try {
      const reply = await this.bridge.taskTerminalClose(target.scopeId, {
        taskId: target.taskId,
        terminalId: id,
      });
      if (!this.currentSelection(target, revision)) return;
      if (!reply.ok)
        this.error.set(
          reply.error.code === "outcome-unknown"
            ? "Closing outcome is unknown. Inspect the refreshed tabs before trying again."
            : reply.error.message,
        );
    } catch {
      if (this.currentSelection(target, revision))
        this.error.set(
          "Closing outcome is unknown. Inspect the refreshed tabs before trying again.",
        );
    } finally {
      this.closing.delete(key);
      // Reject list replies started before cleanup settled, then reconcile without retrying close.
      if (
        !this.disposed &&
        this.connected() &&
        this.selection()?.scopeId === target.scopeId &&
        this.selection()?.taskId === target.taskId
      )
        await this.refresh();
    }
  }
  private closeKey(target: TerminalSelection, id: number): string {
    return JSON.stringify([target.scopeId, target.taskId, id]);
  }
  async action(id: number, type: "interrupt" | "rerun"): Promise<void> {
    await this.mutate(id, type);
  }
  private async mutate(
    id: number,
    type: "interrupt" | "rerun",
  ): Promise<void> {
    const target = this.selection(),
      terminal = this.snapshot()?.terminals.find((row) => row.id === id),
      revision = this.revision;
    if (
      !target ||
      !terminal ||
      !this.connected() ||
      this.busy() ||
      !terminal.generation
    )
      return;
    this.busy.set(true);
    this.error.set("");
    try {
      const input = { taskId: target.taskId, terminalId: id };
      const reply = await this.bridge.taskTerminalAction(target.scopeId, {
        ...input,
        generation: terminal.generation,
        type,
      });
      if (!this.currentSelection(target, revision)) return;
      if (!reply.ok)
        this.error.set(
          reply.error.code === "outcome-unknown"
            ? "The action may have completed. Inspect the terminal before trying again."
            : reply.error.message,
        );
      await this.refresh();
    } catch {
      if (this.currentSelection(target, revision))
        this.error.set(
          "The action outcome is unknown. Inspect the terminal before trying again.",
        );
    } finally {
      if (revision === this.revision) this.busy.set(false);
    }
  }
  async read(
    target: TerminalSelection,
    id: number,
    generation: string | null,
    after: number,
  ): Promise<TaskTerminalOutput | null> {
    const revision = this.revision;
    if (!this.currentSelection(target, revision) || this.active() !== id)
      return null;
    const reply = await this.bridge.taskTerminalRead(target.scopeId, {
      taskId: target.taskId,
      terminalId: id,
      generation,
      after,
    });
    if (!this.currentSelection(target, revision) || this.active() !== id)
      return null;
    if (!reply.ok) {
      this.readFailed(reply.error.message);
      return null;
    }
    this.readRecovered();
    const terminal = reply.value.terminal;
    this.resetSeenForGeneration([terminal]);
    // Output bytes never enter Signals. Update Angular only when toolbar metadata changes.
    const old = this.snapshot()?.terminals.find((row) => row.id === id);
    if (
      old &&
      JSON.stringify({ ...old, sequence: 0 }) !==
        JSON.stringify({ ...terminal, sequence: 0 })
    )
      this.snapshot.update((snapshot) =>
        snapshot
          ? {
              ...snapshot,
              terminals: snapshot.terminals.map((row) =>
                row.id === id ? terminal : row,
              ),
            }
          : null,
      );
    return reply.value;
  }
  private readFailed(message: string): void {
    this.lastReadError = message;
    this.error.set(message);
  }
  private readRecovered(): void {
    if (this.lastReadError !== null && this.error() === this.lastReadError)
      this.error.set("");
    this.lastReadError = null;
  }
  private resetSeenForGeneration(
    rows: readonly TaskTerminal[],
    complete = false,
  ): void {
    const previous = this.snapshot()?.terminals;
    const seen = new Map(this.seen());
    let changed = false;
    if (complete) {
      const ids = new Set(rows.map((row) => row.id));
      for (const id of seen.keys())
        if (!ids.has(id)) {
          seen.delete(id);
          changed = true;
        }
    }
    for (const row of rows) {
      const old = previous?.find((item) => item.id === row.id);
      if (old && old.generation !== row.generation && seen.delete(row.id))
        changed = true;
    }
    if (changed) this.seen.set(seen);
  }
  markSeen(id: number, sequence: number): void {
    if ((this.seen().get(id) ?? 0) < sequence) {
      const seen = new Map(this.seen());
      seen.set(id, sequence);
      this.seen.set(seen);
    }
  }
  async input(
    target: TerminalSelection,
    id: number,
    gen: string,
    data: string,
  ): Promise<BackendResult<{ readonly accepted: true }>> {
    if (
      !this.currentSelection(target, this.revision) || this.active() !== id
    )
      return {
        ok: false,
        error: {
          code: "stale-scope",
          message: "Terminal selection changed or disconnected. Input was not sent.",
        },
      };
    return this.bridge.taskTerminalInput(target.scopeId, {
      taskId: target.taskId,
      terminalId: id,
      generation: gen,
      data,
    });
  }
  async resize(
    target: TerminalSelection,
    id: number,
    gen: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    if (!this.currentSelection(target, this.revision) || this.active() !== id)
      throw new Error("Terminal selection changed or disconnected.");
    const reply = await this.bridge.taskTerminalResize(target.scopeId, {
      taskId: target.taskId,
      terminalId: id,
      generation: gen,
      cols,
      rows,
    });
    if (!reply.ok) throw new Error(reply.error.message);
  }
}
