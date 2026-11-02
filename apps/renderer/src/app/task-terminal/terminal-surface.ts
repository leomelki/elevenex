import type { TerminalStyleLease } from "./terminal-style-nonce";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

/** DOM/ANSI ownership only. No transport, process or Angular output subscriptions. */
export class TerminalSurface {
  readonly terminal: Terminal;
  private readonly fitAddon = new FitAddon();
  private readonly disposers: { dispose(): void }[] = [];
  private observer?: ResizeObserver;
  private themeObserver?: MutationObserver;
  private resizeFrame?: number;
  private mounted = false;
  private styleLease?: TerminalStyleLease;
  private disposed = false;
  private readonly writes = new Set<() => void>();
  private searchPosition = -1;
  private query = "";
  sequence = 0;
  generation: string | null = null;
  constructor(
    input: (data: string) => void,
    private readonly resized: (cols: number, rows: number) => void,
    private readonly retainStyles: () => TerminalStyleLease,
  ) {
    this.terminal = new Terminal({
      scrollback: 2000,
      cursorBlink: false,
      cursorInactiveStyle: "outline",
      screenReaderMode: true,
      convertEol: false,
      allowProposedApi: false,
      disableStdin: true,
      logLevel: "off",
      // Output cannot navigate or read/write the clipboard. Browser opening is a separate typed intent.
      linkHandler: { activate: () => {} },
    });
    this.terminal.loadAddon(this.fitAddon);
    this.disposers.push(
      this.terminal.onData(input),
      this.terminal.onResize((size) => resized(size.cols, size.rows)),
      this.terminal.parser.registerOscHandler(52, () => true),
    );
    this.terminal.attachCustomKeyEventHandler((event) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        ["t", "f"].includes(event.key.toLowerCase())
      )
        return false;
      // Let the browser copy the actual user selection; Ctrl-C without a selection interrupts the process.
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "c" &&
        this.terminal.hasSelection()
      )
        return false;
      return true;
    });
  }
  attach(container: HTMLElement, enabled: boolean): void {
    if (this.disposed) return;
    if (!this.mounted) {
      const lease = this.retainStyles();
      try {
        lease.open(() => this.terminal.open(container));
        this.styleLease = lease;
        this.mounted = true;
      } catch (error) {
        lease.release();
        throw error;
      }
    } else if (this.terminal.element) container.append(this.terminal.element);
    this.detachObservers();
    this.terminal.options.disableStdin = !enabled;
    this.applyTheme();
    this.themeObserver = new MutationObserver(() => this.applyTheme());
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(container);
    this.fit();
  }
  detach(): void {
    this.terminal.options.disableStdin = true;
    this.detachObservers();
    this.terminal.element?.remove();
  }
  setEnabled(enabled: boolean): void {
    this.terminal.options.disableStdin = !enabled;
  }
  focus(): void {
    this.terminal.focus();
  }
  fit(): void {
    if (this.resizeFrame !== undefined) return;
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = undefined;
      if (
        this.disposed ||
        !this.terminal.element?.isConnected ||
        !this.terminal.element.offsetWidth
      )
        return;
      const size = this.fitAddon.proposeDimensions();
      if (size) {
        const cols = Math.max(2, Math.min(500, size.cols)),
          rows = Math.max(1, Math.min(300, size.rows));
        if (this.terminal.cols !== cols || this.terminal.rows !== rows)
          this.terminal.resize(cols, rows);
        else this.resized(cols, rows);
      }
    });
  }
  async write(data: string): Promise<void> {
    if (!data || this.disposed) return;
    await new Promise<void>((resolve) => {
      const complete = () => {
        this.writes.delete(complete);
        resolve();
      };
      this.writes.add(complete);
      this.terminal.write(data, complete);
    });
  }
  reset(): void {
    this.terminal.reset();
    this.sequence = 0;
    this.searchPosition = -1;
  }
  context(): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let row = Math.max(0, buffer.length - 80); row < buffer.length; row++)
      lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
    return lines.join("\n").trim().slice(-8000);
  }
  search(
    query: string,
    backwards = false,
  ): { matches: number; current: number } {
    const buffer = this.terminal.buffer.active,
      matches: { row: number; col: number; length: number }[] = [];
    const needle = query.toLocaleLowerCase();
    if (!needle) {
      this.terminal.clearSelection();
      this.query = "";
      this.searchPosition = -1;
      return { matches: 0, current: 0 };
    }
    for (let row = 0; row < buffer.length && matches.length < 1000; row++) {
      const line =
        buffer.getLine(row)?.translateToString(false).toLocaleLowerCase() ?? "";
      // String offsets differ from terminal columns for wide/combined Unicode cells.
      if (!line.includes(needle)) continue;
      const columns: number[] = [],
        ends: number[] = [];
      const bufferLine = buffer.getLine(row);
      for (let column = 0; bufferLine && column < bufferLine.length; column++) {
        const cell = bufferLine.getCell(column);
        if (!cell || cell.getWidth() === 0) continue;
        const text = (cell.getChars() || " ").toLocaleLowerCase();
        for (let unit = 0; unit < text.length; unit++) {
          columns.push(column);
          ends.push(column + cell.getWidth());
        }
      }
      let from = 0,
        col: number;
      while ((col = line.indexOf(needle, from)) >= 0 && matches.length < 1000) {
        const column = columns[col] ?? col;
        matches.push({
          row,
          col: column,
          length:
            (ends[col + needle.length - 1] ?? column + query.length) - column,
        });
        from = col + Math.max(1, needle.length);
      }
    }
    this.searchPosition =
      query !== this.query
        ? backwards
          ? matches.length - 1
          : 0
        : (this.searchPosition + (backwards ? -1 : 1) + matches.length) %
          Math.max(1, matches.length);
    this.query = query;
    const hit = matches[this.searchPosition];
    if (hit) {
      this.terminal.select(hit.col, hit.row, hit.length);
      this.terminal.scrollToLine(hit.row);
    } else this.terminal.clearSelection();
    return {
      matches: matches.length,
      current: hit ? this.searchPosition + 1 : 0,
    };
  }
  private applyTheme(): void {
    if (!this.terminal.element) return;
    const style = getComputedStyle(this.terminal.element),
      token = (name: string) => style.getPropertyValue("--" + name).trim();
    const fontSize = Number.parseFloat(token("text-code-size"));
    const lineHeight = Number.parseFloat(token("text-code-line"));
    if (token("font-mono"))
      this.terminal.options.fontFamily = `"Elevenex Terminal Symbols", ${token("font-mono")}`;
    if (Number.isFinite(fontSize) && fontSize > 0) {
      this.terminal.options.fontSize = fontSize;
      if (Number.isFinite(lineHeight) && lineHeight > 0)
        this.terminal.options.lineHeight = lineHeight / fontSize;
    }
    this.terminal.options.theme = {
      background: token("surface-sunken"),
      foreground: token("ink"),
      cursor: token("accent"),
      cursorAccent: token("surface-sunken"),
      selectionBackground: token("accent-soft"),
      selectionForeground: token("ink"),
      black: token("surface-sunken"),
      red: token("danger"),
      green: token("diff-add"),
      yellow: token("attention"),
      blue: token("code-function"),
      magenta: token("code-keyword"),
      cyan: token("accent"),
      white: token("ink"),
      brightBlack: token("ink-muted"),
      brightRed: token("danger"),
      brightGreen: token("diff-add"),
      brightYellow: token("attention"),
      brightBlue: token("code-function"),
      brightMagenta: token("code-keyword"),
      brightCyan: token("accent"),
      brightWhite: token("ink"),
    };
  }
  private detachObservers(): void {
    this.observer?.disconnect();
    this.themeObserver?.disconnect();
    if (this.resizeFrame !== undefined) cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = undefined;
  }
  dispose(): void {
    this.disposed = true;
    this.detachObservers();
    for (const complete of this.writes) complete();
    for (const disposer of this.disposers) disposer.dispose();
    try {
      this.terminal.dispose();
    } finally {
      this.styleLease?.release();
      this.styleLease = undefined;
    }
  }
}

/** Load bundled prompt glyphs before xterm measures and caches their cell widths. */
export async function prepareTerminalFonts(): Promise<void> {
  const size = getComputedStyle(document.documentElement)
    .getPropertyValue("--text-code-size")
    .trim();
  try {
    await document.fonts.load(
      `${size} "Elevenex Terminal Symbols"`,
      String.fromCodePoint(0xe0a0, 0xe718),
    );
  } catch {
    /* A missing font asset must not prevent shell interaction. */
  }
}
