import { BrowserWindow, ipcMain, type WebContents, type WebFrameMain } from 'electron';
import type { EventContracts, InvokeContracts } from '@elevenex/shared';

export function handle<C extends keyof InvokeContracts>(
  channel: C,
  trusted: (frame: WebFrameMain | null, contents: WebContents) => boolean,
  handler: (...args: InvokeContracts[C]['args']) => InvokeContracts[C]['result'] | Promise<InvokeContracts[C]['result']>,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!trusted(event.senderFrame, event.sender)) throw new Error('Untrusted IPC sender');
    // IPC is an untyped runtime boundary; handlers must also validate their inputs.
    return handler(...(args as InvokeContracts[C]['args']));
  });
}

export function broadcast<C extends keyof EventContracts>(channel: C, value: EventContracts[C]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(channel, value);
    }
  }
}
