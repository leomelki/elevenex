import { randomUUID } from 'node:crypto';
import { TerminalOutputBuffer } from '../terminal/terminal-output-buffer.js';
import {
  TerminalOutputEvents,
  type TerminalOutputEvent,
} from './terminal-output-events.js';
import type { ShellIntegrationState } from './desktop-shell-integration.js';

export const DESKTOP_TERMINAL_INITIAL_SIZE = { cols: 80, rows: 24 } as const;

/** Bounded process-owned stream. Character offsets use JS UTF-16 on both ends. */
export class DesktopTerminalStream {
  readonly generation = randomUUID();
  private readonly output = new TerminalOutputBuffer(256 * 1024);
  // Keep resize boundaries with the bytes so replaying startup in a narrow pane
  // cannot wrap zsh's prompt-spacer line.
  private readonly sizes: { at: number; cols: number; rows: number }[] = [
    { at: 0, ...DESKTOP_TERMINAL_INITIAL_SIZE },
  ];
  sequence = 0;
  status: 'idle' | 'running' | 'serving' | 'failed' | 'exited' = 'running';
  exitCode: number | null = null;
  port: number | null = null;
  protocol: 'http' | 'https' | undefined;
  command: string;
  private rerunCommand: string | null = null;
  private processExited = false;
  private promptReady = false;
  private commandStarted = false;
  private submittedInput = false;
  private typeahead = false;
  private inputDuringCommand = false;
  private readonly events: TerminalOutputEvents;
  private integrationState?: ShellIntegrationState;
  private integrationStarted = Date.now();

  get integration(): ShellIntegrationState | undefined {
    return this.integrationState === 'pending' &&
      Date.now() - this.integrationStarted >= 10000
      ? 'unavailable'
      : this.integrationState;
  }
  configureIntegration(state: ShellIntegrationState): void {
    this.integrationState = state;
    this.integrationStarted = Date.now();
  }

  constructor(
    readonly script: {
      id: string;
      file: string;
      args: string[];
      cmd: string;
    } | null = null,
    promptToken: string | null = null,
  ) {
    this.command = script?.cmd ?? '';
    this.events = new TerminalOutputEvents(promptToken);
    if (!script && promptToken) this.integrationState = 'pending';
  }
  append(data: string): void {
    this.sequence += data.length;
    this.output.append(data);
    this.trimSizes();
    this.events.append(data, (event) => this.outputEvent(event));
  }
  private outputEvent(event: TerminalOutputEvent): void {
    if (this.processExited) return;
    if (event.type === 'service') {
      if (this.status === 'running' || this.status === 'serving') {
        this.port = event.port;
        this.protocol = event.protocol;
        this.status = 'serving';
      }
      return;
    }
    if (
      this.script ||
      this.integrationState === 'disabled' ||
      this.integrationState === 'unsupported'
    )
      return;
    if (event.type === 'disabled') {
      this.integrationState = 'disabled';
      this.promptReady = false;
      this.rerunCommand = null;
      return;
    }
    this.integrationState = 'active';
    if (event.type === 'command') {
      this.command = event.command ?? 'Shell command';
      this.rerunCommand = (
        this.commandStarted ? this.inputDuringCommand : this.typeahead
      )
        ? null
        : event.command;
    } else if (event.type === 'ready') {
      this.promptReady = true;
      this.submittedInput = false;
      this.typeahead = false;
      this.inputDuringCommand = false;
    } else {
      this.promptReady = false;
      this.port = null;
      this.protocol = undefined;
      if (event.type === 'started') {
        this.commandStarted = true;
        this.inputDuringCommand = this.typeahead;
        this.submittedInput = false;
        this.typeahead = false;
        this.status = 'running';
        this.exitCode = null;
      } else {
        this.commandStarted = false;
        this.exitCode = event.code;
        this.status = event.code ? 'failed' : 'idle';
      }
    }
  }
  resize(cols: number, rows: number): void {
    const last = this.sizes[this.sizes.length - 1];
    if (last.cols === cols && last.rows === rows) return;
    const size = { at: this.sequence, cols, rows };
    if (last.at === size.at) this.sizes[this.sizes.length - 1] = size;
    else this.sizes.push(size);
    this.trimSizes();
  }
  private trimSizes(): void {
    const first = Math.max(0, this.sequence - 256 * 1024);
    // Bound resize-only activity as well as output. If geometry expires sooner
    // than bytes, reads report the usual history gap rather than guessing a grid.
    while (
      this.sizes.length > 1 &&
      (this.sizes[1].at <= first || this.sizes.length > 256)
    )
      this.sizes.shift();
  }
  input(data: string): void {
    // An unfinished/edited prompt must never receive an injected rerun. We only
    // invalidate readiness here; command text comes exclusively from shell hooks.
    if (data) {
      this.promptReady = false;
      this.rerunCommand = null;
      if (this.commandStarted) this.inputDuringCommand = true;
      else {
        if (this.submittedInput) this.typeahead = true;
        // Track only submission boundaries, never command text. Data after an
        // Enter may be program input or an unfinished future prompt; neither
        // permits an injected rerun until a new shell command is identified.
        const submission = data.search(/[\r\n]/);
        if (submission >= 0) {
          this.submittedInput = true;
          if (submission < data.length - 1) this.typeahead = true;
        }
      }
    }
  }
  exited(code: number): void {
    this.processExited = true;
    this.promptReady = false;
    this.exitCode = Math.max(0, Math.min(255, code));
    this.port = null;
    this.status = code ? 'failed' : 'exited';
  }
  get canRerun(): boolean {
    return (
      this.status === 'failed' &&
      (!!this.script ||
        (!this.processExited && this.promptReady && !!this.rerunCommand))
    );
  }
  /** Only an authenticated shell-reported command can be repeated. */
  rerunInput(): string | null {
    return this.canRerun && !this.script ? this.rerunCommand + '\r' : null;
  }
  read(generation: string | null, after: number) {
    const data = this.output.snapshot();
    const bufferFirst = this.sequence - data.length;
    const first = Math.max(bufferFirst, this.sizes[0].at);
    const gap =
      generation !== this.generation || after < first || after > this.sequence;
    let from = gap ? first : after;
    // Do not split a surrogate pair at a response boundary.
    if (from > first && /[\uDC00-\uDFFF]/.test(data[from - bufferFirst] ?? ''))
      from--;
    const index = this.sizes.findIndex((size) => size.at > from);
    const size = this.sizes[index < 0 ? this.sizes.length - 1 : index - 1];
    let next = Math.min(
      this.sequence,
      from + 32768,
      index < 0 ? Infinity : this.sizes[index].at,
    );
    if (
      next < this.sequence &&
      /[\uDC00-\uDFFF]/.test(data[next - bufferFirst] ?? '')
    )
      next--;
    return {
      generation: this.generation,
      from,
      next,
      data: data.slice(from - bufferFirst, next - bufferFirst),
      gap,
      more: next < this.sequence,
      size: { cols: size.cols, rows: size.rows },
    };
  }
}
