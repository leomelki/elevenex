import { performance } from 'node:perf_hooks';
import type { TerminalOutputEvent } from './terminal-output-events.js';

export interface TrackedTerminalCommand {
  readonly id: number;
  readonly command: string | null;
  readonly confidence: 'exact' | 'history' | 'unavailable';
  readonly cwd: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly durationMs: number | null;
  readonly outputStart: number | null;
  readonly outputEnd: number | null;
  readonly exitCode: number | null;
  readonly state: 'running' | 'completed' | 'interrupted';
}

/** Process-owned metadata, separate from output retention. No input is retained.
 * Completion pages contain immutable records, so an incremental reader never
 * misses updates to an earlier running record. */
export class TerminalCommandTracker {
  cwd: string | null = null;
  private nextId = 1;
  private pending: Pick<
    TrackedTerminalCommand,
    'command' | 'confidence'
  > | null = null;
  private active: TrackedTerminalCommand | null = null;
  private startedClock: number | null = null;
  private readonly history: TrackedTerminalCommand[] = [];
  private retainedUnits = 0;

  get current(): TrackedTerminalCommand | null {
    return this.active;
  }
  get latest(): TrackedTerminalCommand | null {
    return this.history.at(-1) ?? null;
  }

  event(event: TerminalOutputEvent): void {
    if (event.type === 'cwd') {
      this.cwd = event.cwd;
      return;
    }
    if (event.type === 'command') {
      const metadata: Pick<TrackedTerminalCommand, 'command' | 'confidence'> = {
        command: event.command,
        confidence: event.command ? event.confidence : 'unavailable',
      };
      if (this.active) this.active = { ...this.active, ...metadata };
      else if (event.command !== null || event.confidence === 'exact')
        this.pending = metadata;
    } else if (event.type === 'started') {
      if (this.active) this.finish('interrupted', null, event.at);
      this.begin(event.at);
    } else if (event.type === 'completed') {
      // Bash can preserve a user's DEBUG trap by reporting only at completion.
      if (!this.active && this.pending) this.begin(null);
      if (this.active) this.finish('completed', event.code, event.at);
      this.pending = null;
    } else if (event.type === 'disabled') this.interrupt(event.at);
  }

  private begin(at: number | null): void {
    this.active = {
      id: this.nextId++,
      command: this.pending?.command ?? null,
      confidence: this.pending?.confidence ?? 'unavailable',
      cwd: this.cwd,
      startedAt: at === null ? null : Date.now(),
      finishedAt: null,
      durationMs: null,
      outputStart: at,
      outputEnd: null,
      exitCode: null,
      state: 'running',
    };
    this.startedClock = at === null ? null : performance.now();
    this.pending = null;
  }
  private finish(
    state: 'completed' | 'interrupted',
    code: number | null,
    at: number,
  ): void {
    if (!this.active) return;
    const finished = {
      ...this.active,
      state,
      exitCode: code,
      finishedAt: Date.now(),
      outputEnd: at,
      durationMs:
        this.startedClock === null
          ? null
          : Math.max(0, Math.round(performance.now() - this.startedClock)),
    };
    this.history.push(finished);
    this.retainedUnits +=
      (finished.command?.length ?? 0) + (finished.cwd?.length ?? 0);
    // Bound both records and text, independently of repository/terminal activity.
    while (this.history.length > 200 || this.retainedUnits > 128 * 1024) {
      const first = this.history.shift()!;
      this.retainedUnits -=
        (first.command?.length ?? 0) + (first.cwd?.length ?? 0);
    }
    this.active = null;
    this.startedClock = null;
  }
  interrupt(at: number): void {
    this.finish('interrupted', null, at);
    this.pending = null;
  }
  starts(from: number, next: number) {
    return [...this.history, ...(this.active ? [this.active] : [])]
      .filter(
        (command) =>
          command.outputStart !== null &&
          command.outputStart > from &&
          command.outputStart <= next,
      )
      .map((command) => ({ id: command.id, at: command.outputStart! }));
  }
  page(after: number) {
    const first = this.history[0]?.id ?? this.active?.id ?? this.nextId;
    const last = this.history.at(-1)?.id ?? first - 1;
    const gap = after < first - 1 || after > last;
    const from = gap ? first - 1 : after;
    const commands = this.history
      .filter((command) => command.id > from)
      .slice(0, 20);
    const next = commands.at(-1)?.id ?? from;
    return { commands, current: this.active, next, gap, more: next < last };
  }
}
