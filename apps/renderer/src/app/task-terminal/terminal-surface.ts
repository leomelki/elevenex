import type { TerminalStyleLease } from "./terminal-style-nonce";
import type { TaskTerminalSize } from "@elevenex/shared";
import { type IMarker, Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { findTerminalMatches } from "./terminal-search";
import { TerminalCellRenderer } from "./terminal-cell-renderer";
import { TerminalLocalEcho } from './terminal-local-echo';

/** DOM/ANSI ownership only. No transport, process or Angular output subscriptions. */
export class TerminalSurface {
  readonly terminal: Terminal;
  readonly localEcho: TerminalLocalEcho;
  private readonly fitAddon = new FitAddon();
  private readonly disposers: { dispose(): void }[] = [];
  private observer?: ResizeObserver;
  private themeObserver?: MutationObserver;
  private resizeFrame?: number;
  private mounted = false;
  private styleLease?: TerminalStyleLease;
  private cellRenderer?: TerminalCellRenderer;
  private disposed = false;
  private readonly writes = new Set<() => void>();
  private replaying = false;
  private fitting = false;
  private searchPosition = -1;
  private query = "";
  private commandMarkers: IMarker[] = [];
  private navigationMarker?: IMarker;
  private navigationViewport?: number;
  sequence = 0;
  generation: string | null = null;
  constructor(
    input: (data: string) => boolean | void,
    private readonly resized: (cols: number, rows: number) => void,
    private readonly retainStyles: () => TerminalStyleLease,
    private readonly interaction: { readonly binary?: (data: string) => void; readonly focused?: () => void } = {},
  ) {
    this.terminal = new Terminal({
      scrollback: 2000,
      cursorBlink: false,
      cursorInactiveStyle: "outline",
      screenReaderMode: true,
      convertEol: false,
      // Unicode providers are an official, version-pinned xterm addon API.
      allowProposedApi: true,
      disableStdin: true,
      logLevel: "off",
      // The DOM renderer ignores this; the WebGL addon draws shapes to cell edges.
      customGlyphs: true,
      // Output cannot navigate or read/write the clipboard. Browser opening is a separate typed intent.
      linkHandler: { activate: () => {} },
    });
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new Unicode11Addon());
    this.terminal.unicode.activeVersion = '11';
    this.localEcho = new TerminalLocalEcho(this.terminal);
    this.disposers.push(
      this.terminal.onData(data => {
        this.navigationMarker = undefined;
        if (input(data) !== false) this.localEcho.input(data);
      }),
      this.terminal.onBinary(data => { this.localEcho.suspend(); this.interaction.binary?.(data); }),
      this.terminal.onScroll(viewport => {
        if (viewport !== this.terminal.buffer.active.baseY) this.localEcho.suspend();
        if (viewport !== this.navigationViewport) this.navigationMarker = undefined;
      }),
      this.terminal.onResize((size) => {
        this.localEcho.suspend();
        if (!this.replaying) resized(size.cols, size.rows);
      }),
      this.terminal.parser.registerOscHandler(52, () => true),
    );
    // Stream terminals have one server-side protocol responder, including when
    // hidden. Public parser hooks consume queries in views without duplicating
    // CPR/DA/DECRQSS responses or leaking a speculative cursor to the PTY.
    for (const id of [
      { final: 'n' }, { prefix: '?', final: 'n' }, { final: 'c' },
      { prefix: '>', final: 'c' }, { prefix: '=', final: 'c' },
      { intermediates: '$', final: 'p' }, { prefix: '?', intermediates: '$', final: 'p' },
      { final: 't' },
    ]) this.disposers.push(this.terminal.parser.registerCsiHandler(id, () => this.serverProtocol));
    this.disposers.push(this.terminal.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, () => this.serverProtocol));
    this.terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey &&
          (event.key === 'ArrowUp' || event.key === 'ArrowDown') && this.navigateCommand(event.key === 'ArrowUp')) {
        event.preventDefault();
        return false;
      }
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
  private serverProtocol = false;
  setServerProtocol(enabled: boolean): void { this.serverProtocol = enabled; }
  attach(container: HTMLElement, enabled: boolean, replay = false): void {
    if (this.disposed) return;
    this.replaying = replay;
    if (!this.mounted) {
      const lease = this.retainStyles();
      try {
        lease.open(() => this.terminal.open(container));
        this.styleLease = lease;
        const element = this.terminal.element;
        const blur = () => this.localEcho.suspend();
        element?.addEventListener('focusout', blur);
        const focused = () => this.interaction.focused?.();
        element?.addEventListener('focusin', focused);
        this.disposers.push({ dispose: () => element?.removeEventListener('focusout', blur) });
        this.disposers.push({ dispose: () => element?.removeEventListener('focusin', focused) });
        this.cellRenderer = new TerminalCellRenderer(this.terminal, lease);
        this.mounted = true;
      } catch (error) {
        lease.release();
        throw error;
      }
    } else if (this.terminal.element) container.append(this.terminal.element);
    this.detachObservers();
    this.terminal.options.disableStdin = !enabled;
    this.applyTheme();
    this.cellRenderer?.attach();
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
    this.localEcho.suspend();
    this.terminal.options.disableStdin = true;
    this.detachObservers();
    this.cellRenderer?.detach();
    this.terminal.element?.remove();
  }
  setEnabled(enabled: boolean): void {
    if (!enabled) this.localEcho.suspend();
    this.terminal.options.disableStdin = !enabled;
  }
  focus(): void {
    this.terminal.focus();
  }
  fit(): void {
    if (this.resizeFrame !== undefined) return;
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = undefined;
      void this.fitVisible();
    });
  }
  private async fitVisible(): Promise<void> {
    if (this.fitting) return;
    this.fitting = true;
    try {
      if (
        this.disposed ||
        this.replaying ||
        !this.terminal.element?.isConnected ||
        !this.terminal.element.offsetWidth
      )
        return;
      let size = this.fitAddon.proposeDimensions();
      if (size) {
        let cols = Math.max(2, Math.min(500, size.cols)),
          rows = Math.max(1, Math.min(300, size.rows));
        if (this.terminal.cols !== cols || this.terminal.rows !== rows) {
          // Rollback must finish before reflow; onResize would be too late.
          // A no-op fit must leave the prediction epoch intact.
          this.localEcho.suspend(); await this.writeChunk('');
          if (this.disposed || this.replaying || !this.terminal.element?.isConnected) return;
          size = this.fitAddon.proposeDimensions();
          if (!size) return;
          cols = Math.max(2, Math.min(500, size.cols)); rows = Math.max(1, Math.min(300, size.rows));
          this.terminal.resize(cols, rows);
        }
        else this.resized(cols, rows);
      }
    } finally { this.fitting = false; }
  }
  async write(data: string, size?: TaskTerminalSize, more = false,
    starts: readonly { readonly id: number; readonly at: number }[] = [], from = this.sequence): Promise<void> {
    if (this.disposed) return;
    if (size) {
      // Replay with the producer's grid, including across output pages. Local
      // fitting resumes after catch-up; historical resizes must never reach the PTY.
      this.replaying = true;
      if (this.terminal.cols !== size.cols || this.terminal.rows !== size.rows) {
        this.localEcho.suspend(); await this.writeChunk('');
        if (this.disposed) return;
        this.terminal.resize(size.cols, size.rows);
      }
    }
    let written = 0;
    for (const start of starts) {
      const end = start.at - from;
      if (end <= written || end > data.length) continue;
      await this.writeChunk(data.slice(written, end));
      if (this.disposed) return;
      const marker = this.terminal.registerMarker();
      if (marker) this.commandMarkers.push(marker);
      written = end;
    }
    await this.writeChunk(data.slice(written));
    this.commandMarkers = this.commandMarkers.filter(marker => !marker.isDisposed);
    while (this.commandMarkers.length > 200) this.commandMarkers.shift()!.dispose();
    if (!this.disposed && this.replaying && !more) {
      this.replaying = false;
      this.fit();
    }
  }
  private async writeChunk(data: string): Promise<void> {
    if (this.disposed) return;
    const output = this.localEcho.beforeOutput() + data;
    await new Promise<void>(resolve => {
      const complete = () => { this.writes.delete(complete); resolve(); };
      this.writes.add(complete);
      this.terminal.write(output, complete);
    });
  }
  /** Navigate server-authenticated command starts; xterm markers follow reflow. */
  navigateCommand(backwards: boolean): boolean {
    const markers = this.commandMarkers.filter(marker => !marker.isDisposed);
    if (!markers.length || this.terminal.buffer.active.type !== 'normal') return false;
    const buffer = this.terminal.buffer.active;
    const anchor = this.navigationMarker && !this.navigationMarker.isDisposed ? this.navigationMarker.line :
      buffer.viewportY === buffer.baseY ? buffer.baseY + buffer.cursorY + 1 : buffer.viewportY;
    const marker = backwards ? [...markers].reverse().find(item => item.line < anchor) : markers.find(item => item.line > anchor);
    if (marker) {
      this.navigationViewport = Math.min(marker.line, buffer.baseY);
      this.navigationMarker = marker;
      this.terminal.scrollToLine(marker.line);
    }
    return true;
  }
  private clearMarkers(): void {
    for (const marker of this.commandMarkers) marker.dispose();
    this.commandMarkers = [];
    this.navigationMarker = undefined;
    this.navigationViewport = undefined;
  }
  reset(): void {
    this.localEcho.reset();
    this.clearMarkers();
    // Queue RIS behind any in-flight drawing; a synchronous reset would allow
    // already queued speculative writes to paint into the replacement buffer.
    this.terminal.write('\x1bc');
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
    const buffer = this.terminal.buffer.active;
    const needle = query.toLocaleLowerCase();
    if (!needle) {
      this.terminal.clearSelection();
      this.query = "";
      this.searchPosition = -1;
      return { matches: 0, current: 0 };
    }
    const matches = findTerminalMatches(buffer, needle, this.terminal.cols);
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
    const fontSize = Number.parseFloat(token("text-terminal-size"));
    const lineHeight = Number.parseFloat(token("text-terminal-line"));
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
    this.localEcho.dispose();
    this.disposed = true;
    this.clearMarkers();
    this.detachObservers();
    for (const complete of this.writes) complete();
    for (const disposer of this.disposers) disposer.dispose();
    try {
      this.cellRenderer?.detach();
      this.terminal.dispose();
    } finally {
      this.styleLease?.release();
      this.styleLease = undefined;
    }
  }
}

/** Load bundled prompt glyphs before xterm measures and caches their cell widths. */
export async function prepareTerminalFonts(): Promise<void> {
  const style = getComputedStyle(document.documentElement);
  const size = style.getPropertyValue("--text-terminal-size").trim();
  const textFamily = style.getPropertyValue("--font-mono").trim();
  try {
    await Promise.all([
      document.fonts.load(`${size} "Elevenex Terminal Symbols"`, String.fromCodePoint(0xe0a0, 0xe718, 0xf0001)),
      document.fonts.load(`${size} ${textFamily}`, 'MWmw0123'),
      document.fonts.load(`bold ${size} ${textFamily}`, 'MWmw0123'),
    ]);
  } catch {
    /* A missing font asset must not prevent shell interaction. */
  }
}

/** Initial fit uses the same local font/tokens as xterm. Actual FitAddon
 * measurement follows attachment; no guessed fixed character size is persisted. */
export function initialTerminalSize(host: HTMLElement): TaskTerminalSize | undefined {
  const style = getComputedStyle(host), parent = host.parentElement;
  const width = host.clientWidth || parent?.clientWidth || 0, height = host.clientHeight || parent?.clientHeight || 0;
  const fontSize = Number.parseFloat(style.getPropertyValue('--text-terminal-size'));
  const lineHeight = Number.parseFloat(style.getPropertyValue('--text-terminal-line'));
  if (!width || !height || !fontSize || !lineHeight) return undefined;
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return undefined;
  context.font = `${fontSize}px ${style.getPropertyValue('--font-mono')}`;
  const cellWidth = context.measureText('W').width;
  if (!cellWidth) return undefined;
  const horizontal = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
  const vertical = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  return { cols: Math.max(2, Math.min(500, Math.floor((width - horizontal) / cellWidth))),
    rows: Math.max(1, Math.min(300, Math.floor((height - vertical) / lineHeight))) };
}
