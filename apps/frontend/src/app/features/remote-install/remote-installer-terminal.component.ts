import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  effect,
  inject,
} from '@angular/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

import { RemoteInstallFlowService } from '@/shared/services/remote-install-flow.service';

// Owns the xterm instance for the remote installer SSH session. Modeled on
// UserTerminalViewComponent so it shares the same robust setup: the xterm CSS is
// imported from the component SCSS, the fit addon is guarded against zero-size
// containers, fonts trigger a refit, and clipboard/OSC 52 behave like a native
// terminal. Living in its own component means the xterm lifecycle is tied to
// `*ngIf` mount/unmount rather than the parent's `ngAfterViewChecked`.
@Component({
  selector: 'app-remote-installer-terminal',
  standalone: true,
  templateUrl: './remote-installer-terminal.component.html',
  styleUrls: ['./remote-installer-terminal.component.scss'],
})
export class RemoteInstallerTerminalComponent implements AfterViewInit, OnDestroy {
  private readonly flow = inject(RemoteInstallFlowService);

  @ViewChild('terminalContainer', { static: true }) container!: ElementRef<HTMLElement>;

  private terminal?: Terminal;
  private fitAddon?: FitAddon;
  private resizeObserver?: ResizeObserver;
  private renderedChunks = 0;

  // Stream new output chunks into the terminal as the flow service accumulates
  // them. Runs in the component injection context; the guard means early runs
  // (before the terminal is created) are no-ops and the initial flush happens
  // in ngAfterViewInit.
  private readonly writeEffect = effect(() => {
    const output = this.flow.state()?.terminalOutput ?? [];
    this.flush(output);
  });

  ngAfterViewInit(): void {
    this.initTerminal();
    this.flush(this.flow.state()?.terminalOutput ?? []);
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(this.container.nativeElement);
  }

  ngOnDestroy(): void {
    this.writeEffect.destroy();
    this.resizeObserver?.disconnect();
    this.terminal?.dispose();
    this.terminal = undefined;
  }

  private initTerminal(): void {
    this.terminal = new Terminal({
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'block',
      theme: {
        background: '#1a1b26',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        cursorAccent: '#1a1b26',
        selectionBackground: '#364a82',
        selectionForeground: '#c0caf5',
        black: '#15161e',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#a9b1d6',
        brightBlack: '#414868',
        brightRed: '#f7768e',
        brightGreen: '#9ece6a',
        brightYellow: '#e0af68',
        brightBlue: '#7aa2f7',
        brightMagenta: '#bb9af7',
        brightCyan: '#7dcfff',
        brightWhite: '#c0caf5',
      },
      allowProposedApi: true,
      scrollback: 1000,
      scrollSensitivity: 5,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon());

    this.terminal.open(this.container.nativeElement);

    // OSC 52 clipboard: tmux/CLIs copy text via this escape sequence.
    this.terminal.parser.registerOscHandler(52, (data) => {
      const idx = data.indexOf(';');
      const payload = idx !== -1 ? data.slice(idx + 1) : data;
      if (payload && payload !== '?') {
        try {
          navigator.clipboard.writeText(atob(payload));
        } catch {
          /* ignore decode errors */
        }
      }
      return true;
    });

    // Match native terminal clipboard shortcuts across platforms.
    this.terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== 'keydown') return true;
      const isSelectAll =
        (event.ctrlKey && event.shiftKey && event.code === 'KeyA') ||
        (event.metaKey && event.code === 'KeyA');
      if (isSelectAll) {
        this.terminal?.selectAll();
        return false;
      }
      const isCopy =
        (event.ctrlKey && event.shiftKey && event.code === 'KeyC') ||
        (event.metaKey && event.code === 'KeyC');
      if (isCopy) {
        const selection = this.terminal?.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection);
        }
        return false;
      }
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyV') {
        navigator.clipboard.readText().then((text) => {
          if (text) this.terminal?.paste(text);
        });
        return false;
      }
      if ((event.metaKey || event.ctrlKey) && event.code === 'KeyV') {
        return false;
      }
      return true;
    });

    setTimeout(() => this.fit(), 0);
    document.fonts?.ready.then(() => this.fit());

    this.terminal.onData((data) => {
      void this.flow.sendInput(data);
    });

    this.terminal.onResize(({ cols, rows }) => {
      void this.flow.resize(cols, rows);
    });
  }

  // Write only the chunks not yet rendered. When the backing array shrinks
  // (a new installer session reset terminalOutput to []), reset and replay.
  private flush(output: string[]): void {
    if (!this.terminal) return;
    if (output.length < this.renderedChunks) {
      this.terminal.reset();
      this.renderedChunks = 0;
    }
    if (output.length > this.renderedChunks) {
      this.terminal.write(output.slice(this.renderedChunks).join(''));
      this.renderedChunks = output.length;
    }
  }

  private fit(): void {
    try {
      const el = this.container?.nativeElement;
      if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return;
      this.fitAddon?.fit();
    } catch {
      // Terminal may not be visible yet.
    }
  }
}
