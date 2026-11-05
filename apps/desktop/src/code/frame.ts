import { webContents, type WebFrameMain } from 'electron';
import { waitForCodeLayout } from './layout-settlement';

/** Privileged control stays in main. The iframe receives no preload or message
 * dispatcher; these are fixed embedder operations, never caller-supplied code. */
export class CodeFrame {
  constructor(public windowId: number, readonly url: string) {}
  private closing?: Promise<boolean>;
  private layout?: Promise<unknown>;
  current(): WebFrameMain | undefined {
    const contents = webContents.fromId(this.windowId);
    if (!contents || contents.isDestroyed()) return undefined;
    return contents.mainFrame.frames.find(frame => !frame.detached && frame.url === this.url);
  }
  async command(command: string, ...args: readonly unknown[]): Promise<unknown> {
    const frame = this.current();
    if (!frame) throw new Error('The task editor is still opening.');
    return frame.executeJavaScript(`import('/assets/out/vs/workbench/workbench.web.main.internal.js').then(({commands}) => commands.executeCommand(${JSON.stringify(command)},...${JSON.stringify(args)}))`);
  }
  async focus(): Promise<void> {
    const frame = this.current();
    if (frame) await frame.executeJavaScript("window.focus();import('/assets/out/vs/workbench/workbench.web.main.internal.js').then(({commands}) => commands.executeCommand('elevenex.code.focus'))");
  }
  async settleLayout(width?: number): Promise<void> {
    await this.waitForLayout(width, false);
  }
  async waitForViewport(width: number): Promise<void> {
    await this.waitForLayout(width, true);
  }
  private async waitForLayout(width: number | undefined, viewportOnly: boolean): Promise<void> {
    const frame = this.current();
    if (!frame) throw new Error('The task editor is still opening.');
    const layout = frame.executeJavaScript(`(${waitForCodeLayout.toString()})(${width === undefined ? 'innerWidth' : JSON.stringify(width)},${JSON.stringify(viewportOnly)})`);
    this.layout = layout;
    try { await layout; } finally { if (this.layout === layout) this.layout = undefined; }
  }
  cancelLayout(): void {
    if (this.layout) void this.current()?.executeJavaScript("document.dispatchEvent(new Event('elevenex-code-layout-cancel'))").catch(() => undefined);
  }
  async reload(): Promise<void> {
    const contents = webContents.fromId(this.windowId);
    await contents?.executeJavaScript(`{const frame=Array.from(document.querySelectorAll('iframe')).find(frame=>frame.src===${JSON.stringify(this.url)});if(frame)frame.src=${JSON.stringify(this.url)};}`);
  }
  close(): Promise<boolean> { return this.closing ??= this.closeWhenReady().finally(() => { this.closing = undefined; }); }
  private async closeWhenReady(): Promise<boolean> {
    // Let upstream veto until debounced hot-exit backups have committed. A
    // dirty-count snapshot alone is never sufficient permission to unload.
    // BeforeUnloadEvent is not constructible in Chromium; a cancelable Event
    // exercises upstream’s synchronous veto without displaying a browser dialog.
    for (let attempt = 0; attempt < 40; attempt++) {
      const frame = this.current();
      if (!frame) return true;
      try {
        if (await frame.executeJavaScript("window.dispatchEvent(new Event('beforeunload',{cancelable:true}))")) {
          await this.remove();
          for (let wait = 0; wait < 50 && this.current(); wait++) await new Promise<void>(resolve => setTimeout(resolve, 10));
          return !this.current();
        }
      } catch { return !this.current(); }
      await new Promise<void>(resolve => setTimeout(resolve, 200));
    }
    return false;
  }
  private async remove(): Promise<void> {
    const contents = webContents.fromId(this.windowId);
    if (!contents || contents.isDestroyed()) return;
    await contents.executeJavaScript(`Array.from(document.querySelectorAll('iframe')).find(frame=>frame.src===${JSON.stringify(this.url)})?.remove()`);
  }
}
