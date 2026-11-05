import { TerminalStylePolicy } from "./terminal-style-nonce";
import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import type { TaskTerminal, TerminalBrowserIntent } from "@elevenex/shared";
import { TerminalViewComponent, type TerminalTab } from "../views";
import { ButtonComponent } from "../ui";
import {
  TaskTerminalStore,
  type TerminalSelection,
} from "./task-terminal.store";
import { TerminalInputQueue } from "./terminal-input";
import type { TerminalSurface } from "./terminal-surface";

interface SurfaceEntry {
  readonly surface: TerminalSurface;
  readonly input: TerminalInputQueue;
  target: TerminalSelection;
  terminal: TaskTerminal;
  notice: string;
  resizing: boolean;
  reading?: Promise<void>;
  desiredSize?: { cols: number; rows: number };
  size?: string;
}
export interface TerminalQuestion {
  readonly scopeId: string;
  readonly taskId: number;
  readonly command: string;
  readonly code: number;
  readonly output: string;
}

@Component({
  selector: "ex-task-terminal",
  providers: [TaskTerminalStore],
  imports: [TerminalViewComponent, ButtonComponent],
  templateUrl: "./task-terminal.component.html",
  styleUrl: "./task-terminal.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskTerminalComponent {
  readonly machineId = input("local");
  private lastMachine = "";
  private readonly started = signal(false);
  readonly selection = input<TerminalSelection | null>(null);
  readonly visible = input(false);
  readonly available = input(true);
  readonly askAvailable = input(false);
  readonly question = output<TerminalQuestion>();
  readonly browserRequested = output<TerminalBrowserIntent>();
  readonly lastClosed = output<void>();
  readonly store = inject(TaskTerminalStore);
  private readonly styles = inject(TerminalStylePolicy);
  private focusOnAttach = false;
  private readonly host = viewChild<ElementRef<HTMLElement>>("surface");
  private readonly surfaces = new Map<string, SurfaceEntry>();
  private attached?: SurfaceEntry;
  private revision = 0;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  readonly notice = signal("");
  readonly animateTabs = signal(false);
  private tabTask = "";
  private openingTask = "";
  private openingAttempted = false;
  readonly inputBlocked = signal(false);
  readonly searchResult = signal("");
  readonly searchMatches = signal<number | null>(null);
  readonly current = this.store.current;
  readonly tabs = computed<readonly TerminalTab[]>(() =>
    (this.store.snapshot()?.terminals ?? []).map((row) => ({
      id: String(row.id),
      title: row.port ? `${row.title} :${row.port}` : row.title,
      tip: `${row.title} · ${row.status}${row.status === "exited" ? " · shell exited" : ""}`,
      cwd: row.cwd,
      branch: row.branch,
      cmd: row.command,
      status:
        row.status === "unavailable" || row.status === "exited"
          ? "idle"
          : row.status,
      ...(row.port ? { port: row.port } : {}),
      unread:
        row.id !== this.store.active() &&
        row.sequence > (this.store.seen().get(row.id) ?? 0),
    })),
  );
  readonly failure = computed(() => {
    const row = this.current();
    return row?.status === "failed" && row.exitCode !== null
      ? { code: row.exitCode, cmd: row.command || row.title }
      : null;
  });
  readonly disabled = computed(
    () =>
      !this.available() ||
      !this.store.connected() ||
      this.store.busy() ||
      this.store.loading(),
  );
  constructor() {
    afterRenderEffect(() => {
      const machine = this.machineId();
      if (this.lastMachine !== machine) {
        this.lastMachine = machine;
        this.store.reset();
        this.stopAttachment();
        for (const entry of this.surfaces.values()) this.disposeEntry(entry);
        this.surfaces.clear();
      }
      if (this.visible()) this.started.set(true);
      if (this.started()) {
        const selected = this.selection(),
          key = selected ? `${machine}:${selected.taskId}` : "";
        if (key !== this.tabTask) {
          this.tabTask = key;
          this.animateTabs.set(false);
        }
        this.store.select(selected);
      }
    });
    afterRenderEffect((onCleanup) => {
      const target = this.store.selection();
      const key = this.visible() && target
        ? `${this.machineId()}:${target.taskId}`
        : "";
      const available = this.available() && this.store.connected();
      if (key !== this.openingTask) {
        this.openingTask = key;
        this.openingAttempted = false;
      }
      if (!key || !available || this.openingAttempted) return;
      // One attempt per opening/task, never a mutation retry on poll or reconnect.
      this.openingAttempted = true;
      const controller = new AbortController();
      onCleanup(() => controller.abort());
      untracked(() => void this.open(controller.signal));
    });
    afterRenderEffect(() => {
      const selection = this.store.selection(),
        id = this.store.active(),
        visible = this.visible(),
        host = this.host()?.nativeElement;
      this.store.connected();
      this.available();
      const terminal = untracked(this.current);
      this.stopAttachment();
      if (id && selection && terminal && visible && host)
        void this.attach(selection, terminal, host, this.revision);
    });
    afterRenderEffect((onCleanup) => {
      if (!this.store.snapshot() || this.animateTabs()) return;
      const frame = requestAnimationFrame(() => this.animateTabs.set(true));
      onCleanup(() => cancelAnimationFrame(frame));
    });
    afterRenderEffect(() => {
      const snapshot = this.store.snapshot();
      if (!snapshot) return;
      const ids = new Set(snapshot.terminals.map((terminal) => terminal.id));
      for (const [key, entry] of this.surfaces) {
        if (
          entry.target.taskId !== snapshot.taskId ||
          ids.has(entry.terminal.id)
        )
          continue;
        if (entry === this.attached) this.stopAttachment();
        this.disposeEntry(entry);
        this.surfaces.delete(key);
      }
    });
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true;
      this.stopAttachment();
      for (const entry of this.surfaces.values()) this.disposeEntry(entry);
      this.surfaces.clear();
    });
  }
  private stopAttachment(): void {
    this.revision++;
    clearTimeout(this.timer);
    if (this.attached) {
      this.attached.input.reconnect();
      this.attached.desiredSize = undefined;
      this.attached.size = undefined;
      this.attached.surface.detach();
    }
    this.attached = undefined;
  }
  private async attach(
    target: TerminalSelection,
    terminal: TaskTerminal,
    host: HTMLElement,
    revision: number,
  ): Promise<void> {
    const key = `${target.taskId}:${terminal.id}`;
    let entry = this.surfaces.get(key);
    if (!entry) {
      const { TerminalSurface, prepareTerminalFonts } =
        await import("./terminal-surface");
      await prepareTerminalFonts();
      if (this.disposed || revision !== this.revision) return;
      const surface = new TerminalSurface(
        (data) => {
          const active = this.surfaces.get(key);
          if (active && active === this.attached && this.canType(active))
            active.input.push(data);
        },
        (cols, rows) => {
          const active = this.surfaces.get(key);
          if (active && active === this.attached) {
            active.desiredSize = { cols, rows };
            void this.resize(active);
          }
        },
        () => this.styles.retain(),
      );
      const input = new TerminalInputQueue(
        async (data, target) => {
          const reply = await this.store.input(
            target,
            target.terminalId,
            target.generation,
            data,
          );
          return reply.ok;
        },
        (message) => {
          const active = this.surfaces.get(key);
          if (!active) return;
          active.notice = message;
          if (active === this.attached) {
            this.notice.set(message);
            this.inputBlocked.set(active.input.blocked);
            active.surface.setEnabled(
              !active.input.blocked && this.canType(active),
            );
          }
        },
      );
      entry = {
        surface,
        input,
        target,
        terminal,
        notice: "",
        resizing: false,
      };
    }
    if (this.disposed || revision !== this.revision) return;
    if (entry.target.scopeId !== target.scopeId) {
      entry.size = undefined;
    }
    entry.target = target;
    entry.terminal = terminal;
    if (terminal.generation)
      entry.input.bind({ ...target, terminalId: terminal.id, generation: terminal.generation });
    this.surfaces.delete(key);
    this.surfaces.set(key, entry);
    while (this.surfaces.size > 8) {
      const oldest = this.surfaces.keys().next().value!;
      this.disposeEntry(this.surfaces.get(oldest)!);
      this.surfaces.delete(oldest);
    }
    this.attached = entry;
    this.notice.set(entry.notice);
    this.inputBlocked.set(entry.input.blocked);
    entry.surface.attach(host, this.canType(entry), true);
    if (this.focusOnAttach && this.available()) {
      this.focusOnAttach = false;
      entry.surface.focus();
    }
    if (this.store.connected() && this.available())
      void this.pump(entry, revision);
  }
  private canType(entry: SurfaceEntry): boolean {
    return (
      this.available() &&
      this.store.connected() &&
      entry.terminal.alive &&
      !!entry.terminal.generation &&
      !entry.input.blocked
    );
  }
  private async pump(entry: SurfaceEntry, revision: number): Promise<void> {
    // A detached xterm write can still be drawing. Finish its cursor update
    // before a new attachment reads, otherwise the same bytes can render twice.
    await entry.reading;
    if (this.disposed || revision !== this.revision) return;
    const reading = this.readOutput(entry, revision);
    entry.reading = reading;
    try {
      await reading;
    } finally {
      if (entry.reading === reading) entry.reading = undefined;
    }
  }
  private async readOutput(entry: SurfaceEntry, revision: number): Promise<void> {
    let more = false;
    try {
      const reply = await this.store.read(
        entry.target,
        entry.terminal.id,
        entry.surface.generation,
        entry.surface.sequence,
      );
      if (this.disposed || revision !== this.revision) return;
      if (!reply) {
        this.timer = setTimeout(() => void this.pump(entry, revision), 1000);
        return;
      }
      entry.terminal = reply.terminal;
      if (reply.generation)
        entry.input.bind({ ...entry.target, terminalId: entry.terminal.id, generation: reply.generation });
      else entry.input.reconnect();
      if (reply.gap) {
        const firstAttach = entry.surface.generation === null;
        const changed =
          !firstAttach && entry.surface.generation !== reply.generation;
        entry.surface.reset();
        entry.size = undefined;
        entry.surface.fit();
        if (changed || reply.from > 0) {
          entry.notice = changed
            ? "The terminal process changed. Earlier output is unavailable."
            : "Earlier output expired. Showing the retained output window.";
          this.notice.set(entry.notice);
        }
      }
      await entry.surface.write(reply.data, reply.size, reply.more);
      entry.surface.generation = reply.generation;
      entry.surface.sequence = reply.next;
      if (this.disposed || revision !== this.revision) return;
      this.store.markSeen(entry.terminal.id, reply.next);
      entry.surface.setEnabled(this.canType(entry));
      more = reply.more;
    } catch {
      if (revision === this.revision)
        this.notice.set(
          "Connection interrupted. Reattaching does not replay input.",
        );
    }
    if (!this.disposed && revision === this.revision)
      this.timer = setTimeout(
        () => void this.pump(entry, revision),
        more ? 0 : 100,
      );
  }
  private async resize(entry: SurfaceEntry): Promise<void> {
    if (entry.resizing || !entry.terminal.generation) return;
    entry.resizing = true;
    try {
      while (entry.desiredSize && !this.disposed && entry === this.attached) {
        const size = entry.desiredSize;
        entry.desiredSize = undefined;
        const key = `${entry.target.scopeId}:${entry.terminal.generation}:${size.cols}:${size.rows}`;
        if (key === entry.size) continue;
        await this.store.resize(
          entry.target,
          entry.terminal.id,
          entry.terminal.generation,
          size.cols,
          size.rows,
        );
        entry.size = key;
      }
    } catch {
      /* Output reconciliation will restore the next attachment's size. */
    } finally {
      entry.resizing = false;
      if (entry.desiredSize && !this.disposed && entry === this.attached)
        void this.resize(entry);
    }
  }
  interrupt(id: string): void {
    const entry = this.attached;
    if (entry?.terminal.id === Number(id) && this.canType(entry))
      entry.input.push("\x03");
  }
  async create(scriptId?: string): Promise<void> {
    this.focusOnAttach = true;
    await this.store.create(scriptId);
    requestAnimationFrame(() => this.attached?.surface.focus());
  }
  private async open(signal: AbortSignal): Promise<void> {
    const refreshed = await this.store.refresh();
    if (
      signal.aborted || !refreshed || this.store.busy() || this.store.error() ||
      this.store.snapshot()?.terminals.length !== 0
    ) return;
    await this.create();
  }
  async close(id: string): Promise<void> {
    if (this.disposed || !this.store.snapshot()?.terminals.some(row => row.id === Number(id))) return;
    const closing = this.store.close(Number(id));
    // The store removes the tab immediately; process cleanup must not delay hiding the panel.
    if (this.visible() && this.store.snapshot()?.terminals.length === 0)
      this.lastClosed.emit();
    await closing;
  }
  selected(id: string): void {
    this.store.active.set(Number(id));
    this.searchResult.set("");
    this.searchMatches.set(null);
  }
  resumeInput(): void {
    const entry = this.attached;
    if (entry) {
      entry.input.resume();
      entry.notice = "";
      this.notice.set("");
      this.inputBlocked.set(false);
      entry.surface.setEnabled(this.canType(entry));
      entry.surface.focus();
    }
  }
  find(event: { query: string; backwards: boolean }): void {
    const result = this.attached?.surface.search(event.query, event.backwards);
    this.searchMatches.set(event.query && result ? result.matches : null);
    this.searchResult.set(
      event.query && result
        ? result.matches === 0 ? "No results" : `${result.current} of ${result.matches}${result.matches === 1000 ? "+" : ""}`
        : "",
    );
  }
  ask(): void {
    const row = this.current(),
      entry = this.attached;
    if (!row || !entry || !this.askAvailable() || row.exitCode === null) return;
    this.question.emit({
      scopeId: entry.target.scopeId,
      taskId: row.taskId,
      command: row.command || row.title,
      code: row.exitCode,
      output: entry.surface.context(),
    });
  }
  openPort(port: number): void {
    const target = this.selection(),
      row = this.current();
    if (target && row?.port === port)
      this.browserRequested.emit({
        scopeId: target.scopeId,
        taskId: target.taskId,
        terminalId: row.id,
        port,
      });
  }
  private disposeEntry(entry: SurfaceEntry): void {
    entry.input.dispose();
    entry.surface.dispose();
  }
}
