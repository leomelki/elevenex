import {
  AfterViewChecked,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLoaderCircle, lucideTerminalSquare, lucideTriangleAlert, lucideX } from '@ng-icons/lucide';

import { RemoteInstallFlowService } from '@/shared/services/remote-install-flow.service';

@Component({
  selector: 'app-remote-install-modal',
  standalone: true,
  imports: [CommonModule, NgIcon],
  templateUrl: './remote-install-modal.component.html',
  styleUrl: './remote-install-modal.component.scss',
  viewProviders: [
    provideIcons({
      lucideLoaderCircle,
      lucideTerminalSquare,
      lucideTriangleAlert,
      lucideX,
    }),
  ],
})
export class RemoteInstallModalComponent implements AfterViewChecked, OnDestroy {
  private readonly flow = inject(RemoteInstallFlowService);

  @ViewChild('terminalContainer') terminalContainer?: ElementRef<HTMLElement>;

  readonly state = this.flow.state;
  readonly canRetry = computed(() => {
    const state = this.state();
    return Boolean(state && !state.checking);
  });

  terminal = signal<Terminal | null>(null);
  private fitAddon: FitAddon | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private renderedChunks = 0;

  private readonly stateEffect = effect(() => {
    const state = this.state();
    const terminal = this.terminal();
    if (!state) {
      if (terminal) {
        terminal.dispose();
        this.terminal.set(null);
        this.fitAddon = null;
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
      }
      this.renderedChunks = 0;
      return;
    }

    if (!terminal) {
      return;
    }

    const nextChunks = state.terminalOutput.slice(this.renderedChunks);
    if (nextChunks.length > 0) {
      terminal.write(nextChunks.join(''));
      this.renderedChunks = state.terminalOutput.length;
    }
  }, { allowSignalWrites: true });

  ngAfterViewChecked(): void {
    if (!this.state() || this.terminal() || !this.terminalContainer) {
      return;
    }

    const terminal = new Terminal({
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      convertEol: false,
      theme: {
        background: '#0d141b',
        foreground: '#d7e2f0',
        cursor: '#d7e2f0',
      },
    });
    this.fitAddon = new FitAddon();
    terminal.loadAddon(this.fitAddon);
    terminal.open(this.terminalContainer.nativeElement);
    terminal.onData((data) => {
      void this.flow.sendInput(data);
    });
    terminal.onResize(({ cols, rows }) => {
      void this.flow.resize(cols, rows);
    });
    this.terminal.set(terminal);
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(this.terminalContainer.nativeElement);
    this.fit();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.terminal()?.dispose();
    this.terminal.set(null);
  }

  async cancel(): Promise<void> {
    await this.flow.cancel();
  }

  async recheck(): Promise<void> {
    await this.flow.recheck();
  }

  private fit(): void {
    try {
      this.fitAddon?.fit();
    } catch {
      // Terminal may not be visible yet.
    }
  }
}
