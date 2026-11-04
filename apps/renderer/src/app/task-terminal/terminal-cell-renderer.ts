import { WebglAddon } from '@xterm/addon-webgl';
import type { IDisposable, Terminal } from '@xterm/xterm';
import type { TerminalStyleLease } from './terminal-style-nonce';

/** Cell-sized geometric glyphs; retain terminal data independently of GPU resources. */
export class TerminalCellRenderer {
  private addon?: WebglAddon;
  private context?: WebGL2RenderingContext | null;
  private contextLoss?: IDisposable;

  constructor(private readonly terminal: Pick<Terminal, 'element' | 'loadAddon'>, private readonly styles: TerminalStyleLease) {}

  attach(): void {
    if (this.addon) return;
    const addon = new WebglAddon();
    this.addon = addon;
    this.contextLoss = addon.onContextLoss(() => this.detach());
    try {
      this.styles.open(() => this.terminal.loadAddon(addon));
      // Use the public DOM boundary rather than xterm's private renderer services.
      this.context = this.terminal.element
        ?.querySelector<HTMLCanvasElement>('.xterm-screen > canvas:last-of-type')
        ?.getContext('webgl2');
    } catch {
      // GPU availability must never prevent shell input, output or accessibility.
      this.detach();
    }
  }

  detach(): void {
    const addon = this.addon;
    if (!addon) return;
    this.addon = undefined;
    this.contextLoss?.dispose();
    this.contextLoss = undefined;
    const context = this.context;
    this.context = undefined;
    try {
      // Disposing the addon recreates DOM sheets, which also need the window nonce.
      this.styles.open(() => addon.dispose());
    } finally {
      // xterm 0.19 disposes its GL objects but leaves the browser context allocated.
      // Release it explicitly so hidden/evicted task surfaces cannot exhaust GPU contexts.
      context?.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }
}
