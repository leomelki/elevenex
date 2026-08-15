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

import { WslInstallFlowService } from '@/shared/services/wsl-install-flow.service';

// Mirrors RemoteInstallerTerminalComponent exactly (it even reuses that
// component's template/styles, which are already transport-agnostic) but
// drives the WSL installer session instead of the SSH one.
@Component({
  selector: 'app-wsl-installer-terminal',
  standalone: true,
  templateUrl: './remote-installer-terminal.component.html',
  styleUrls: ['./remote-installer-terminal.component.scss'],
})
export class WslInstallerTerminalComponent implements AfterViewInit, OnDestroy {
  private readonly flow = inject(WslInstallFlowService);

  @ViewChild('terminalContainer', { static: true }) container!: ElementRef<HTMLElement>;

  private terminal?: Terminal;
  private fitAddon?: FitAddon;
  private resizeObserver?: ResizeObserver;
  private renderedChunks = 0;

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
