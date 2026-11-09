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
  isDevMode,
  output,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import type { TaskTerminal, TerminalBrowserIntent, TaskTerminalPreferences } from "@elevenex/shared";
import { TerminalViewComponent, type TerminalTab } from "../views";
import { ButtonComponent, ToastComponent } from "../ui";
import {
  TaskTerminalStore,
  type TerminalSelection,
} from "./task-terminal.store";
import { TerminalInputQueue, TERMINAL_INPUT_INTERRUPTED } from "./terminal-input";
import type { TerminalSurface } from "./terminal-surface";
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { TerminalStreamAttachment } from './terminal-stream-attachment';

interface SurfaceEntry {
  readonly surface: TerminalSurface;
  readonly input: TerminalInputQueue;
  target: TerminalSelection;
  terminal: TaskTerminal;
  notice: string;
  resizing: boolean;
  reading?: Promise<void>;
  outputRequested?: boolean;
  desiredSize?: { cols: number; rows: number };
  size?: string;
  stream?: TerminalStreamAttachment;
  streamReady?: boolean;
  retries?: number;
}
export interface TerminalQuestion {
  readonly scopeId: string;
  readonly taskId: number;
  readonly command: string;
  readonly code: number;
  readonly output: string;
}
export interface TerminalBrowserState {
  readonly terminalId: number;
  readonly busy: boolean;
  readonly error: string;
  readonly url: string;
}

@Component({
  selector: "ex-task-terminal",
  providers: [TaskTerminalStore],
  imports: [TerminalViewComponent, ButtonComponent, ToastComponent],
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
  /** External-browser handoff feedback belongs to the selected task/terminal. */
  readonly browserState = input<TerminalBrowserState | null>(null);
  readonly question = output<TerminalQuestion>();
  readonly browserRequested = output<TerminalBrowserIntent>();
  readonly lastClosed = output<void>();
  readonly store = inject(TaskTerminalStore);
  private readonly styles = inject(TerminalStylePolicy);
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  private focusOnAttach = false;
  private readonly host = viewChild<ElementRef<HTMLElement>>("surface");
  private readonly resumeButton = viewChild<unknown, ElementRef<HTMLButtonElement>>('resumeButton', { read: ElementRef });
  private readonly surfaces = new Map<string, SurfaceEntry>();
  private attached?: SurfaceEntry;
  private attachmentKey = '';
  private attachmentHost?: HTMLElement;
  private readonly attachmentCounts = { attach: 0, detach: 0, streamAttach: 0, streamDetach: 0, retry: 0 };
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
  readonly preferences = signal<TaskTerminalPreferences>({ profile: null, prediction: 'auto' });
  readonly prediction = computed(() => this.preferences().prediction === 'auto');
  private preferencesScope = '';
  private preferencesRead?: Promise<void>;
  readonly current = this.store.current;
  private readonly protocolVersion = computed(() => this.store.snapshot()?.streamVersion);
  readonly tabs = computed<readonly TerminalTab[]>(() =>
    (this.store.snapshot()?.terminals ?? []).map((row) => {
      const title = row.activityTitle ?? row.title;
      const detail = title === row.title ? title : `${title} · ${row.title}`;
      return {
        id: String(row.id),
        title: row.port ? `${title} :${row.port}` : title,
        tip: `${detail} · ${row.status}${row.status === "exited" ? " · shell exited" : ""}`,
        cwd: row.currentCwd ?? row.cwd,
        branch: row.branch,
        cmd: row.command,
        status:
          row.status === "unavailable" || row.status === "exited" ||
          (row.status === 'running' && row.shellIntegration !== undefined && row.shellIntegration !== 'active')
            ? "idle"
            : row.status,
        ...(row.port ? { port: row.port } : {}),
        unread:
          row.id !== this.store.active() &&
          row.sequence > (this.store.seen().get(row.id) ?? 0),
      };
    }),
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
      const scope = this.store.selection()?.scopeId ?? '';
      if (scope === this.preferencesScope) return;
      this.preferencesScope = scope;
      this.preferences.set({ profile: null, prediction: 'auto' });
      if (scope) untracked(() => { this.preferencesRead = this.loadPreferences(scope); });
    });
    afterRenderEffect(() => {
      const machine = this.machineId();
      if (this.lastMachine !== machine) {
        this.lastMachine = machine;
        this.store.reset();
        this.stopAttachment('machine-change');
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
        host = this.host()?.nativeElement,
        terminal = this.current();
      const key = id && selection && terminal && visible && host
        ? JSON.stringify([this.machineId(), selection.scopeId, selection.taskId, id,
          terminal.generation, this.protocolVersion(), this.store.connected(), this.available()])
        : '';
      // Attachment work reads/writes metadata and seen cursors. Those are not
      // lifetime dependencies: tracking them creates a detach/attach feedback loop.
      untracked(() => {
        if (key === this.attachmentKey && host === this.attachmentHost) {
          if (this.attached && terminal) {
            this.attached.terminal = terminal;
            this.attached.surface.terminal.options.windowsPty = terminal.windowsPty;
            this.attached.surface.setEnabled(this.canType(this.attached));
          }
          return;
        }
        this.stopAttachment();
        this.attachmentKey = key;
        this.attachmentHost = host;
        if (key && selection && terminal && host)
          void this.attach(selection, terminal, host, this.revision);
      });
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
        if (entry === this.attached) this.stopAttachment('terminal-removed');
        this.disposeEntry(entry);
        this.surfaces.delete(key);
      }
    });
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true;
      this.stopAttachment('destroyed');
      for (const entry of this.surfaces.values()) this.disposeEntry(entry);
      this.surfaces.clear();
    });
  }
  private stopAttachment(reason = 'effect/identity'): void {
    this.revision++;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.attachmentKey) this.diagnoseAttachment('detach', reason);
    this.attachmentKey = '';
    this.attachmentHost = undefined;
    if (this.attached) {
      this.store.markSeen(this.attached.terminal.id, this.attached.surface.sequence);
      if (this.attached.stream) {
        this.diagnoseAttachment('streamDetach', reason);
        if (this.attached.stream.uncertain) this.attached.input.interrupt(TERMINAL_INPUT_INTERRUPTED);
        this.attached.reading = this.attached.stream.settled();
        this.attached.stream.dispose(); this.attached.stream = undefined;
      }
      this.attached.streamReady = false;
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
            return active.input.push(data);
          return false;
        },
        (cols, rows) => {
          const active = this.surfaces.get(key);
          if (active && active === this.attached) {
            active.desiredSize = { cols, rows };
            void this.resize(active);
          }
        },
        () => this.styles.retain(),
        {
          binary: data => {
            const active = this.surfaces.get(key);
            if (active && active === this.attached && active.stream && this.canType(active)) active.input.push(data, 'binary');
          },
          focused: () => this.surfaces.get(key)?.stream?.focus(),
        },
      );
      const input = new TerminalInputQueue(
        async (data, target, kind) => {
          const entry = this.surfaces.get(key);
          if (entry && (entry.target.scopeId !== target.scopeId || entry.target.taskId !== target.taskId)) return false;
          if (entry?.stream) return entry.stream.input(data, target.generation, kind);
          if (kind === 'binary') return false;
          const reply = await this.store.input(
            target,
            target.terminalId,
            target.generation,
            data,
          );
          const active = this.surfaces.get(key);
          if (reply.ok && active === this.attached && active) {
            active.outputRequested = true;
            if (!active.reading) {
              clearTimeout(this.timer);
              this.timer = setTimeout(() => void this.pump(active, this.revision), 0);
            }
          }
          return reply.ok;
        },
        (message) => {
          const active = this.surfaces.get(key);
          if (!active) return;
          active.surface.localEcho.suspend();
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
    this.diagnoseAttachment('attach', 'effect/lifetime');
    this.notice.set(entry.notice);
    this.inputBlocked.set(entry.input.blocked);
    entry.surface.attach(host, this.canType(entry), true);
    entry.surface.terminal.options.windowsPty = terminal.windowsPty;
    entry.surface.localEcho.setEnabled(this.prediction());
    if (this.focusOnAttach && this.available()) {
      this.focusOnAttach = false;
      entry.surface.focus();
    }
    if (this.store.connected() && this.available()) {
      if (this.store.snapshot()?.streamVersion === 1) void this.startStream(entry, revision);
      else { entry.surface.setServerProtocol(false); void this.pump(entry, revision); }
    }
  }
  private async startStream(entry: SurfaceEntry, revision: number): Promise<void> {
    await entry.reading;
    if (this.disposed || revision !== this.revision || entry !== this.attached || entry.stream) return;
    const stream = new TerminalStreamAttachment(this.bridge, entry.target.scopeId, {
      taskId: entry.target.taskId, terminalId: entry.terminal.id, generation: entry.surface.generation, after: entry.surface.sequence,
    }, entry.surface, {
      inputIdle: () => entry.input.idle,
      terminal: terminal => {
        if (entry !== this.attached || revision !== this.revision || entry.stream !== stream) return;
        entry.terminal = terminal;
        entry.surface.terminal.options.windowsPty = terminal.windowsPty;
        if (terminal.generation) entry.input.bind({ ...entry.target, terminalId: terminal.id, generation: terminal.generation });
        this.store.acceptStreamTerminal(entry.target, terminal);
      },
      metadata: value => {
        if (entry === this.attached && revision === this.revision && entry.stream === stream)
          this.store.acceptStreamMetadata(entry.target, value);
      },
      changed: () => {
        if (entry !== this.attached || revision !== this.revision || entry.stream !== stream) return;
        entry.surface.setEnabled(this.canType(entry));
        if (stream.ready && !entry.streamReady) {
          clearTimeout(this.timer); this.timer = undefined;
          entry.size = undefined; entry.retries = 0; entry.surface.fit();
          if (!entry.input.blocked) { entry.notice = ''; this.notice.set(''); }
          if (entry.surface.terminal.element?.contains(document.activeElement)) stream.focus();
        }
        entry.streamReady = stream.ready;
      },
      interrupted: (_message, uncertain) => {
        if (entry !== this.attached || revision !== this.revision || entry.stream !== stream) return;
        this.diagnoseAttachment('retry', 'stream/interrupted');
        this.diagnoseAttachment('streamDetach', 'stream/interrupted');
        entry.reading = stream.settled();
        entry.stream = undefined; entry.streamReady = false;
        if (uncertain) entry.input.interrupt(TERMINAL_INPUT_INTERRUPTED);
        else {
          entry.input.reconnect();
          // Preserve an existing input warning across repeated reconnects.
          if (!entry.input.blocked) {
            entry.notice = 'Terminal connection lost. Reconnecting…';
            this.notice.set(entry.notice);
          }
        }
        entry.surface.setEnabled(false);
        void this.store.refresh();
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.startStream(entry, revision);
        }, Math.min(15000, 500 * 2 ** Math.min(5, entry.retries ?? 0)));
        entry.retries = (entry.retries ?? 0) + 1;
      },
    });
    entry.stream = stream;
    this.diagnoseAttachment('streamAttach', entry.retries ? 'stream/retry' : 'effect/lifetime');
    await stream.start();
  }
  private diagnoseAttachment(action: keyof TaskTerminalComponent['attachmentCounts'], reason: string): void {
    if (!isDevMode()) return;
    this.attachmentCounts[action]++;
    // Identity/counters only: never log terminal output, commands or input.
    console.debug('Terminal attachment:', { key: this.attachmentKey, attachmentId: this.attached?.stream?.target.attachmentId,
      action, reason, ...this.attachmentCounts });
  }
  private canType(entry: SurfaceEntry): boolean {
    return (
      this.available() &&
      this.store.connected() &&
      entry.terminal.alive &&
      !!entry.terminal.generation &&
      (this.store.snapshot()?.streamVersion !== 1 || entry.stream?.ready === true) &&
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
    entry.outputRequested = false;
    const inputRevision = entry.surface.localEcho.inputRevision;
    const inputIdle = entry.input.idle;
    try {
      const reply = await this.store.read(
        entry.target,
        entry.terminal.id,
        entry.surface.generation,
        entry.surface.sequence,
      );
      if (this.disposed || revision !== this.revision) return;
      if (!reply) {
        entry.surface.localEcho.suspend();
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
      await entry.surface.write(reply.data, reply.size, reply.more, reply.commandStarts, reply.from);
      entry.surface.generation = reply.generation;
      entry.surface.sequence = reply.next;
      if (this.disposed || revision !== this.revision) return;
      entry.surface.localEcho.reconcile(reply.inputPreview?.prompt, inputRevision, inputIdle, reply.data.length > 0);
      this.store.markSeen(entry.terminal.id, reply.next);
      entry.surface.setEnabled(this.canType(entry));
      more = reply.more;
    } catch {
      entry.surface.localEcho.suspend();
      if (revision === this.revision)
        this.notice.set(
          "Connection interrupted. Reattaching does not replay input.",
        );
    }
    if (!this.disposed && revision === this.revision)
      this.timer = setTimeout(
        () => void this.pump(entry, revision),
        more || entry.outputRequested ? 0 : 100,
      );
  }
  private async resize(entry: SurfaceEntry): Promise<void> {
    if (entry.resizing || !entry.terminal.generation || !entry.terminal.alive ||
        (this.protocolVersion() === 1 && !entry.stream?.ready)) return;
    entry.resizing = true;
    try {
      while (entry.desiredSize && !this.disposed && entry === this.attached && entry.terminal.alive &&
          (this.protocolVersion() !== 1 || entry.stream?.ready)) {
        const size = entry.desiredSize;
        entry.desiredSize = undefined;
        const key = `${entry.target.scopeId}:${entry.terminal.generation}:${size.cols}:${size.rows}`;
        if (key === entry.size) continue;
        if (entry.stream) await entry.stream.resize(size.cols, size.rows);
        else await this.store.resize(
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
      if (entry.desiredSize && !this.disposed && entry === this.attached && entry.terminal.alive &&
          (this.protocolVersion() !== 1 || entry.stream?.ready))
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
    const target = this.store.selection(), host = this.host()?.nativeElement;
    let size;
    if (host && this.store.snapshot()?.streamVersion === 1) {
      await this.preferencesRead;
      const { prepareTerminalFonts, initialTerminalSize } = await import('./terminal-surface');
      await prepareTerminalFonts();
      if (this.disposed || target?.scopeId !== this.store.selection()?.scopeId || target?.taskId !== this.store.selection()?.taskId) return;
      size = initialTerminalSize(host);
    }
    await this.store.create(scriptId, true, size, this.preferences().profile ?? undefined);
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
    this.focusOnAttach = true;
    if (this.store.active() === Number(id) && this.attached && this.visible() && this.available()) {
      this.focusOnAttach = false;
      this.attached.surface.focus();
    }
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
  dismissNotice(): void {
    if (this.attached) this.attached.notice = '';
    this.notice.set('');
    if (this.inputBlocked()) this.resumeButton()?.nativeElement.focus();
    else this.attached?.surface.focus();
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
  async ask(): Promise<void> {
    const row = this.current(),
      entry = this.attached;
    if (!row || !entry || !this.askAvailable() || row.exitCode === null) return;
    const scope = entry.target.scopeId;
    let output: string;
    if (entry.stream && row.generation) {
      const reply = await this.bridge.taskTerminalContext(entry.target.scopeId, { taskId: row.taskId, terminalId: row.id, generation: row.generation });
      if (!reply.ok || entry !== this.attached || entry.target.scopeId !== scope || this.current()?.generation !== row.generation || !this.askAvailable()) return;
      output = reply.value;
    } else {
      entry.surface.localEcho.suspend();
      await entry.surface.write('\x00');
      if (entry !== this.attached) return;
      output = entry.surface.context();
    }
    this.question.emit({
      scopeId: entry.target.scopeId,
      taskId: row.taskId,
      command: row.command || row.title,
      code: row.exitCode,
      output,
    });
  }
  private async loadPreferences(scope: string): Promise<void> {
    let reply;
    try { reply = await this.bridge.taskTerminalPreferences(scope); } catch { return; }
    if (this.preferencesScope !== scope || this.disposed) return;
    if (reply?.ok) {
      this.preferences.set(reply.value);
      for (const entry of this.surfaces.values()) entry.surface.localEcho.setEnabled(this.prediction());
    }
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
