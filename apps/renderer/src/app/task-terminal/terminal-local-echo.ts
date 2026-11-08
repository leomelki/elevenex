import type { Terminal } from '@xterm/xterm';

interface ScreenLine {
  readonly row: number;
  readonly column: number;
  readonly text: string;
  readonly prefix: string;
}

/** Speculative pixels only: never write predictions into xterm's ANSI buffer,
 * scrollback, selection, accessibility tree or agent context. The server wins. */
export class TerminalLocalEcho {
  inputRevision = 0;
  private prompt = 0;
  private active = false;
  private floor = 0;
  private confirmed?: ScreenLine;
  private pending: ScreenLine[] = [];
  private overlay?: HTMLDivElement;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly terminal: Terminal) {}

  /** Call only after the output page has been parsed. A revoked prompt cannot
   * be rearmed by a delayed read from before Enter, detach or a failed input. */
  reconcile(prompt: number | undefined, readRevision = this.inputRevision, allowNewPrompt = true): void {
    if (prompt === undefined) { this.suspend(); return; }
    // GET and input POST travel independently. Only a read started after all
    // earlier input acknowledgements can grant a new prompt safely.
    if (prompt > this.prompt && !allowNewPrompt) { this.suspend(); return; }
    if (prompt > this.prompt) this.floor = this.terminal.buffer.active.cursorX;
    const screen = this.screen();
    if (!screen) { this.suspend(); return; }
    if (prompt > this.prompt) {
      this.suspend();
      this.prompt = prompt;
      if (readRevision !== this.inputRevision) return;
      this.active = true;
      this.floor = screen.column;
      this.confirmed = screen;
    } else if (this.active && this.confirmed) {
      let matched = -1;
      for (let index = 0; index < this.pending.length; index++) {
        if (sameLine(screen, this.pending[index]!)) matched = index;
      }
      if (matched >= 0) {
        this.pending.splice(0, matched + 1);
        this.confirmed = screen;
        clearTimeout(this.timer);
        this.timer = this.pending.length ? setTimeout(() => this.suspend(), 5000) : undefined;
      } else if (!sameLine(screen, this.confirmed)) {
        // Covers completion, asynchronous output, redraws with different text,
        // cursor movement and another client's input, without parsing ANSI twice.
        this.suspend();
      }
    }
    if (!this.pending.length) { clearTimeout(this.timer); this.timer = undefined; }
    this.render();
  }

  /** Observe accepted user input synchronously, before waiting on transport. */
  input(data: string): void {
    this.inputRevision++;
    if (!this.active || !this.confirmed || !data) return;
    if (!this.screen() || data.length > 256 || this.pending.length + data.length > 256) {
      this.suspend(); return;
    }
    for (const char of data) {
      const last = this.pending.at(-1) ?? this.confirmed;
      let next: ScreenLine;
      if (char === '\x7f' || char === '\x08') {
        if (last.column <= this.floor) { this.suspend(); return; }
        next = { ...last, column: last.column - 1, text: last.text.padEnd(last.column - this.floor).slice(0, -1) };
      } else if (char >= ' ' && char <= '~' && last.column < this.terminal.cols - 1) {
        next = { ...last, column: last.column + 1, text: last.text.padEnd(last.column - this.floor) + char };
      } else {
        // Never predict submission, escape sequences, bracketed paste, Unicode
        // widths, wrapping, history or foreground-program/password input.
        this.suspend(); return;
      }
      this.pending.push(next);
    }
    // A dead connection must not leave unconfirmed text displayed indefinitely.
    if (!this.timer) this.timer = setTimeout(() => this.suspend(), 5000);
    this.render();
  }

  suspend(): void {
    this.active = false;
    this.confirmed = undefined;
    this.pending = [];
    clearTimeout(this.timer);
    this.timer = undefined;
    this.overlay?.remove();
    this.overlay = undefined;
  }

  reset(): void {
    this.suspend();
    this.prompt = 0;
  }

  private screen(): ScreenLine | undefined {
    const buffer = this.terminal.buffer.active;
    if (buffer.type !== 'normal' || buffer.viewportY !== buffer.baseY ||
        this.terminal.modes.mouseTrackingMode !== 'none') return undefined;
    const row = buffer.baseY + buffer.cursorY;
    const line = buffer.getLine(row);
    if (!line || line.isWrapped) return undefined;
    const text = line.translateToString(true, this.floor);
    // Predictions only append to a single line; existing suggestions to the
    // right and wide/combined cells belong to the shell's own line editor.
    if (buffer.cursorX < this.floor || text.length > buffer.cursorX - this.floor ||
        line.translateToString(false, this.floor, buffer.cursorX).length !== buffer.cursorX - this.floor)
      return undefined;
    return { row, column: buffer.cursorX, text, prefix: line.translateToString(false, 0, this.floor) };
  }

  private render(): void {
    const expected = this.pending.at(-1), observed = this.confirmed;
    const screen = this.terminal.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!expected || !observed || !screen) { this.overlay?.remove(); return; }
    const rect = screen.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const width = rect.width / this.terminal.cols, height = rect.height / this.terminal.rows;
    const overlay = this.overlay ??= document.createElement('div');
    overlay.className = 'ex-terminal-local-echo';
    overlay.setAttribute('aria-hidden', 'true');
    Object.assign(overlay.style, {
      position: 'absolute', pointerEvents: 'none', userSelect: 'none', whiteSpace: 'pre',
      left: `${this.floor * width}px`,
      top: `${(expected.row - this.terminal.buffer.active.viewportY) * height}px`,
      height: `${height}px`, lineHeight: `${height}px`,
      width: `${(Math.max(expected.column, observed.column) - this.floor + 1) * width}px`,
      fontFamily: this.terminal.options.fontFamily ?? 'monospace',
      fontSize: `${this.terminal.options.fontSize}px`,
      fontWeight: String(this.terminal.options.fontWeight ?? 'normal'),
      letterSpacing: `${this.terminal.options.letterSpacing ?? 0}px`,
      color: 'var(--ink)', backgroundColor: 'var(--surface-sunken)',
    });
    // Fixed-width cells avoid differences between DOM and GPU font rounding.
    overlay.replaceChildren();
    for (let column = this.floor; column <= Math.max(expected.column, observed.column); column++) {
      const cell = document.createElement('span');
      cell.textContent = expected.text[column - this.floor] ?? ' ';
      Object.assign(cell.style, { display: 'inline-block', width: `${width}px` });
      if (column === expected.column) {
        cell.style.backgroundColor = 'var(--accent)';
        cell.style.color = 'var(--surface-sunken)';
      }
      overlay.append(cell);
    }
    screen.append(overlay);
  }
}

function sameLine(left: ScreenLine, right: ScreenLine): boolean {
  return left.row === right.row && left.column === right.column && left.prefix === right.prefix &&
    left.text.trimEnd() === right.text.trimEnd();
}
