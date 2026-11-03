import { randomUUID } from 'node:crypto';
import { TerminalOutputBuffer } from '../terminal/terminal-output-buffer.js';

/** Bounded process-owned stream. Character offsets use JS UTF-16 on both ends. */
export class DesktopTerminalStream {
  readonly generation = randomUUID();
  private readonly output = new TerminalOutputBuffer(256 * 1024);
  sequence = 0;
  status: 'idle' | 'running' | 'serving' | 'failed' | 'exited' = 'running';
  exitCode: number | null = null;
  port: number | null = null;
  protocol: 'http' | 'https' | undefined;
  command: string;
  private pendingLine = '';
  private reliableLine = true;
  private rerunCommand: string | null = null;
  private pasteMarker = '';
  private bracketedPaste = false;
  private parserTail = '';
  private processExited = false;
  private promptReady = false;

  constructor(
    readonly script: {
      id: string;
      file: string;
      args: string[];
      cmd: string;
    } | null = null,
  ) {
    this.command = script?.cmd ?? '';
  }
  append(data: string): void {
    this.sequence += data.length;
    this.output.append(data);
    const tailLength = this.parserTail.length;
    const text = this.parserTail + data;
    // Prompt integration only reports status; output is never interpreted as a command or URL.
    // OSC status delimiters are literal ESC/BEL; payloads are never executed.
    // eslint-disable-next-line no-control-regex
    for (const match of text.matchAll(/\x1b\]133;([CD])(?:;(\d{1,3}))?\x07/g)) {
      if (this.script) break;
      if (match[1] === 'C') {
        this.promptReady = false;
        this.status = 'running';
        this.exitCode = null;
        this.port = null;
      } else {
        this.promptReady = true;
        this.exitCode = Number(match[2] ?? 0);
        this.status = this.exitCode ? 'failed' : 'idle';
        this.port = null;
      }
    }
    const serving = [
      ...text.matchAll(
        // Recognize a URL before an ANSI color reset, without accepting output navigation.
        // eslint-disable-next-line no-control-regex
        /(https?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5})(?=[/\s\x1b]|$)/g,
      ),
    ]
      .filter((match) => (match.index ?? 0) + match[0].length > tailLength)
      .at(-1);
    const port = serving?.[2];
    if (
      port &&
      Number(port) > 0 &&
      Number(port) <= 65535 &&
      this.status !== 'exited'
    ) {
      this.port = Number(port);
      this.protocol = serving?.[1] === 'https' ? 'https' : 'http';
      this.status = 'serving';
    }
    // Only retain an incomplete suffix. Complete status markers cannot run twice.
    const start = text.lastIndexOf('\x1b]133;');
    this.parserTail =
      start >= 0 && !text.slice(start).includes('\x07')
        ? text.slice(start, start + 128)
        : text.slice(
            start >= 0
              ? Math.max(text.indexOf('\x07', start) + 1, text.length - 100)
              : -100,
          );
  }
  input(data: string): void {
    // Keystrokes while a foreground program runs may be passwords or REPL input.
    // Only a shell prompt can establish a repeatable user command.
    if (this.script || this.processExited || !this.promptReady) return;
    for (const char of data) {
      if (!this.promptReady) break;
      // xterm wraps paste in these markers. They may cross input requests and
      // are framing, not shell edits. All other escape sequences remain unsafe.
      if (char === '\x1b' || this.pasteMarker) {
        this.pasteMarker += char;
        if (this.pasteMarker === '\x1b[200~') {
          if (this.bracketedPaste) this.reliableLine = false;
          this.bracketedPaste = true;
          this.pasteMarker = '';
        } else if (this.pasteMarker === '\x1b[201~') {
          if (!this.bracketedPaste) this.reliableLine = false;
          this.bracketedPaste = false;
          this.pasteMarker = '';
        } else if (
          !'\x1b[200~'.startsWith(this.pasteMarker) &&
          !'\x1b[201~'.startsWith(this.pasteMarker)
        ) {
          this.reliableLine = false;
          this.pasteMarker = '';
        }
        continue;
      }
      // Newlines/controls inside a paste are literal editing-buffer content;
      // never treat them as submission or guess how the shell interpreted them.
      if (this.bracketedPaste && (char < ' ' || char === '\x7f')) {
        this.reliableLine = false;
        continue;
      }
      if (char === '\r' || char === '\n') {
        if (this.pendingLine || !this.reliableLine) {
          this.command = this.reliableLine ? this.pendingLine : 'Shell command';
          this.rerunCommand = this.reliableLine ? this.pendingLine : null;
          this.status = 'running';
          this.promptReady = false;
          this.exitCode = null;
          this.port = null;
        }
        this.pendingLine = '';
        this.reliableLine = true;
      } else if (char === '\x03') {
        this.pendingLine = '';
        this.reliableLine = true;
      } else if (char === '\x7f' || char === '\b')
        this.pendingLine = this.pendingLine.slice(0, -1);
      else if (char === '\x15') {
        this.pendingLine = '';
        this.reliableLine = true;
      } else if (char < ' ' || this.pendingLine.length >= 4096)
        this.reliableLine = false;
      else this.pendingLine += char;
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
        (!this.processExited &&
          this.promptReady &&
          !this.bracketedPaste &&
          !this.pasteMarker &&
          !!this.rerunCommand &&
          this.pendingLine.length === 0 &&
          this.reliableLine))
    );
  }
  /** Only input supplied by a person, never a command extracted from process output. */
  rerunInput(): string | null {
    return this.canRerun && !this.script ? this.rerunCommand + '\r' : null;
  }
  read(generation: string | null, after: number) {
    const data = this.output.snapshot();
    const first = this.sequence - data.length;
    const gap =
      generation !== this.generation || after < first || after > this.sequence;
    let from = gap ? first : after;
    // Do not split a surrogate pair at a response boundary.
    if (from > first && /[\uDC00-\uDFFF]/.test(data[from - first] ?? ''))
      from--;
    let next = Math.min(this.sequence, from + 32768);
    if (
      next < this.sequence &&
      /[\uDC00-\uDFFF]/.test(data[next - first] ?? '')
    )
      next--;
    return {
      generation: this.generation,
      from,
      next,
      data: data.slice(from - first, next - first),
      gap,
      more: next < this.sequence,
    };
  }
}
