import { BrowserWindow, ipcMain, type WebContents, type WebFrameMain } from 'electron';
import type { EventContracts, InvokeContracts } from '@elevenex/shared';

export type TrustedSender = (frame: WebFrameMain | null, contents: WebContents) => boolean;

export function handle<C extends keyof InvokeContracts>(
  channel: C,
  trusted: TrustedSender,
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

export function sendToWindow<C extends keyof EventContracts>(windowId: number, channel: C, value: EventContracts[C]): void {
  const window = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.id === windowId);
  if (window && !window.webContents.isDestroyed()) window.webContents.send(channel, value);
}

/** Window ownership is taken from the verified sender, never a renderer argument. */
export function handleForWindow<C extends keyof InvokeContracts>(
  channel: C, trusted: TrustedSender,
  handler: (windowId: number, ...args: InvokeContracts[C]['args']) => InvokeContracts[C]['result'] | Promise<InvokeContracts[C]['result']>,
): () => void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!trusted(event.senderFrame, event.sender)) throw new Error('Untrusted IPC sender');
    return handler(event.sender.id, ...(args as InvokeContracts[C]['args']));
  });
  return () => ipcMain.removeHandler(channel);
}
