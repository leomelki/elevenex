import type { Terminal } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';

interface ScreenLine {
  readonly row: number;
  readonly column: number;
  readonly text: string;
  readonly prefix: string;
}
interface Prediction { readonly screen: ScreenLine; readonly started: number }

/** Reversible edits through xterm's own renderer. The public serializer saves
 * the affected row/cursor attributes; application code uses no private APIs. */
export class TerminalLocalEcho {
  inputRevision = 0;
  latencyThreshold = 30;
  private enabled = true;
  private prompt = 0;
  private active = false;
  private epochConfirmed = false;
  private floor = 0;
  private confirmed?: ScreenLine;
  private pending: Prediction[] = [];
  private rollback = '';
  private drawn = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly serializer = new SerializeAddon();
  private readonly samples: { latency: number; correct: boolean }[] = [];

  constructor(private readonly terminal: Terminal) { terminal.loadAddon(this.serializer); }
  setEnabled(enabled: boolean): void { this.enabled = enabled; if (!enabled) this.suspend(); }
  get predicting(): boolean { return this.drawn; }

  /** Prepend to real output in the SAME write. Device queries must never observe
   * a speculative cursor or produce duplicate replies during reconciliation. */
  beforeOutput(): string {
    if (!this.drawn) return '';
    this.drawn = false;
    return this.rollback;
  }
  reconcile(prompt: number | undefined, readRevision = this.inputRevision, allowNewPrompt = true, hasOutput = true): void {
    if (prompt === undefined || !this.enabled) { this.suspend(); return; }
    if (prompt > this.prompt && !allowNewPrompt) { this.suspend(); return; }
    if (prompt > this.prompt) this.floor = this.terminal.buffer.active.cursorX;
    const screen = this.screen();
    if (!screen) { this.suspend(); return; }
    if (prompt > this.prompt) {
      this.suspend(); this.prompt = prompt;
      if (readRevision !== this.inputRevision) return;
      this.active = true; this.epochConfirmed = false; this.floor = screen.column; this.confirmed = screen;
    } else if (this.active && this.confirmed) {
      let matched = -1;
      // A net-zero edit may equal the old screen before anything was echoed.
      // Neither an empty acknowledgement nor unchanged cells prove a match.
      if (hasOutput && !sameLine(screen, this.confirmed)) for (let index = 0; index < this.pending.length; index++)
        if (sameLine(screen, this.pending[index]!.screen)) matched = index;
      if (matched >= 0) {
        this.epochConfirmed = true;
        for (const prediction of this.pending.splice(0, matched + 1)) this.record(prediction, true);
        this.confirmed = screen;
      } else if (!sameLine(screen, this.confirmed)) {
        for (const prediction of this.pending) this.record(prediction, false);
        this.suspend(); return;
      }
    }
    if (this.active) this.saveRow();
    clearTimeout(this.timer);
    this.timer = this.pending.length ? setTimeout(() => this.suspend(), 5000) : undefined;
    this.render();
  }
  input(data: string): void {
    this.inputRevision++;
    if (!this.active || !this.confirmed || !data) return;
    if (data.length > 256 || this.pending.length + data.length > 256 ||
        this.terminal.buffer.active.type !== 'normal' || this.terminal.buffer.active.viewportY !== this.terminal.buffer.active.baseY ||
        this.terminal.modes.mouseTrackingMode !== 'none') { this.suspend(); return; }
    // eslint-disable-next-line no-control-regex -- Recognize complete terminal editing-key sequences.
    const keys = /^(?:\x1b(?:\[[DCFH]|O[DCFH]|\[[13478]~)|\x01|\x05|\x15|\x17)$/.test(data) ? [data] : [...data];
    for (const raw of keys) {
      const key = raw.startsWith('\x1bO') ? '\x1b[' + raw.slice(2) : raw;
      const last = this.pending.at(-1)?.screen ?? this.confirmed;
      const index = last.column - this.floor;
      let text = last.text.padEnd(index), cursor = index;
      if (key === '\x7f' || key === '\x08') {
        if (!cursor) { this.suspend(); return; }
        text = text.slice(0, cursor - 1) + text.slice(cursor); cursor--;
      } else if (key === '\x1b[D') cursor = Math.max(0, cursor - 1);
      else if (key === '\x1b[C') cursor = Math.min(text.length, cursor + 1);
      else if (['\x01', '\x1b[H', '\x1b[1~', '\x1b[7~'].includes(key)) cursor = 0;
      else if (['\x05', '\x1b[F', '\x1b[4~', '\x1b[8~'].includes(key)) cursor = text.length;
      else if (key === '\x1b[3~') text = text.slice(0, cursor) + text.slice(cursor + 1);
      else if (key === '\x15') { text = text.slice(cursor); cursor = 0; }
      else if (key === '\x17') {
        const previous = text.slice(0, cursor).replace(/\s*\S+\s*$/, '');
        text = previous + text.slice(cursor); cursor = previous.length;
      } else if (key.length === 1 && key >= ' ' && key <= '~') {
        text = text.slice(0, cursor) + key + text.slice(cursor); cursor++;
      } else { this.suspend(); return; }
      // Shell-specific wrapping/scrolling stays authoritative. Unsupported
      // prediction never disables ordinary terminal input.
      if (this.floor + text.length >= this.terminal.cols - 1) { this.suspend(); return; }
      this.pending.push({ screen: { ...last, text, column: this.floor + cursor }, started: performance.now() });
    }
    if (!this.timer) this.timer = setTimeout(() => this.suspend(), 5000);
    this.render();
  }
  suspend(): void {
    const rollback = this.beforeOutput();
    this.active = false; this.confirmed = undefined; this.pending = [];
    clearTimeout(this.timer); this.timer = undefined;
    if (rollback) this.terminal.write(rollback);
  }
  reset(): void { this.beforeOutput(); this.suspend(); this.prompt = 0; this.samples.length = 0; }
  dispose(): void { this.suspend(); this.serializer.dispose(); }
  private screen(): ScreenLine | undefined {
    const buffer = this.terminal.buffer.active;
    if (buffer.type !== 'normal' || buffer.viewportY !== buffer.baseY || this.terminal.modes.mouseTrackingMode !== 'none' ||
        this.terminal.modes.originMode || this.terminal.modes.insertMode) return undefined;
    const row = buffer.baseY + buffer.cursorY, line = buffer.getLine(row);
    if (!line || line.isWrapped || buffer.cursorX < this.floor) return undefined;
    const text = line.translateToString(true, this.floor);
    if (/[^\x20-\x7e]/.test(text) || text.length > buffer.cursorX - this.floor && !this.pending.length) return undefined;
    return { row, column: buffer.cursorX, text, prefix: line.translateToString(false, 0, this.floor) };
  }
  private saveRow(): void {
    const buffer = this.terminal.buffer.active;
    const row = buffer.baseY + buffer.cursorY;
    const serialized = this.serializer.serialize({ range: { start: row, end: row }, excludeAltBuffer: true, excludeModes: true });
    this.rollback = `\x1b[${buffer.cursorY + 1};1H\x1b[0m\x1b[2K${serialized}\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}H`;
  }
  private render(): void {
    const expected = this.pending.at(-1)?.screen, confirmed = this.confirmed;
    if (!expected || !confirmed || !this.visible()) return;
    const rollback = this.drawn ? this.rollback : '';
    const row = confirmed.row - this.terminal.buffer.active.baseY + 1;
    this.drawn = true;
    this.terminal.write(`${rollback}\x1b[${row};${this.floor + 1}H${expected.text}\x1b[K\x1b[${row};${expected.column + 1}H`);
  }
  private visible(): boolean {
    if (this.latencyThreshold === 0) return true;
    if (!this.epochConfirmed) return false;
    const successes = this.samples.filter(sample => sample.correct);
    if (this.samples.length < 4 || successes.length / this.samples.length < 0.8) return false;
    const latency = successes.map(sample => sample.latency).sort((a, b) => a - b);
    return (latency[Math.floor(latency.length / 2)] ?? 0) >= this.latencyThreshold;
  }
  private record(prediction: Prediction, correct: boolean): void {
    this.samples.push({ correct, latency: performance.now() - prediction.started });
    if (this.samples.length > 24) this.samples.shift();
  }
}
function sameLine(left: ScreenLine, right: ScreenLine): boolean {
  return left.row === right.row && left.column === right.column && left.prefix === right.prefix && left.text.trimEnd() === right.text.trimEnd();
}
