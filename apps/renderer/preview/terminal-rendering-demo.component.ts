import { afterNextRender, ChangeDetectionStrategy, Component, DestroyRef, ElementRef, inject, signal, viewChild } from '@angular/core';
import { ButtonComponent } from '../src/app/ui';
import { TerminalStylePolicy } from '../src/app/task-terminal/terminal-style-nonce';
import { prepareTerminalFonts, TerminalSurface } from '../src/app/task-terminal/terminal-surface';

/** Real terminal adapter with isolated ANSI samples; no PTY or production test hooks. */
@Component({
  selector: 'ex-terminal-rendering-demo',
  imports: [ButtonComponent],
  templateUrl: './terminal-rendering-demo.component.html',
  styleUrl: './terminal-rendering-demo.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TerminalRenderingDemoComponent {
  private readonly styles = inject(TerminalStylePolicy);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('surface');
  readonly ready = signal(false);
  readonly input = signal('');
  readonly paintLatency: number[] = [];
  private readonly pendingKeys: number[] = [];
  private stopMetrics?: () => void;
  private disposed = false;
  surface?: TerminalSurface;

  constructor() {
    afterNextRender(() => void this.mount());
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true;
      this.stopMetrics?.();
      this.surface?.dispose();
    });
  }

  private async mount(): Promise<void> {
    await prepareTerminalFonts();
    if (this.disposed) return;
    this.surface = new TerminalSurface(data => this.input.update(value => value + data), () => {}, () => this.styles.retain());
    this.surface.attach(this.host().nativeElement, true);
    const key = this.surface.terminal.onKey(() => this.pendingKeys.push(performance.now()));
    const render = this.surface.terminal.onRender(() => {
      const now = performance.now();
      if (this.surface?.localEcho.predicting) for (const started of this.pendingKeys) this.paintLatency.push(now - started);
      this.pendingKeys.length = 0;
      if (this.paintLatency.length > 256) this.paintLatency.splice(0, this.paintLatency.length - 256);
    });
    this.stopMetrics = () => { key.dispose(); render.dispose(); };
    await this.surface.write([
      '\x1b[38;2;147;38;139m\ue0b6\x1b[48;2;147;38;139m\x1b[38;2;44;217;175m patrat.us1.prod.dog (error-tracking)\x1b[0m\x1b[38;2;147;38;139m\ue0b4\x1b[0m',
      '\x1b[38;2;147;38;139m\ue0b6\x1b[48;2;147;38;139m\x1b[38;2;44;217;175m rounded \x1b[48;2;232;85;131m\x1b[38;2;147;38;139m\ue0b0\x1b[38;2;255;255;255m ~/elevenex \x1b[0m\x1b[38;2;232;85;131m\ue0b0\x1b[0m',
      '\x1b[7m inverse \ue0b6\ue0b4 \x1b[27m  \x1b[1m\ue0a0 Git\x1b[22m  \ue718 Node  \udb80\udc01 Nerd Font',
      '┌──────────────┐  ╔══════════════╗',
      '│ box drawing  │  ║ double lines ║',
      '└──────────────┘  ╚══════════════╝',
      '█▀▄▌▐░▒▓  \x1b[38;2;44;217;175m████████\x1b[0m',
      'Plain text, bold \x1b[1mtext\x1b[22m, italic \x1b[3mtext\x1b[23m and \x1b[4munderline\x1b[24m',
    ].join('\r\n') + '\r\n');
    this.ready.set(true);
  }

  metrics(lineHeight: number, letterSpacing: number): void {
    if (!this.surface) return;
    this.surface.terminal.options.lineHeight = lineHeight;
    this.surface.terminal.options.letterSpacing = letterSpacing;
    this.surface.fit();
  }
}
