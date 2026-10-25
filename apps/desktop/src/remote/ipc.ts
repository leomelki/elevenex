import type { InvokeContracts } from '@elevenex/shared';
import { handleForWindow, type TrustedSender } from '../ipc';
import type { BackendManager } from '../backend/manager';
import type { RemoteManager } from './manager';
import { arity } from './validation';
import { BrowserWindow, dialog } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function registerRemoteIpc(remote: RemoteManager, backend: BackendManager, trusted: TrustedSender): () => void {
  const cleanup: (() => void)[] = [];
  const register = <C extends keyof InvokeContracts>(channel: C, count: number, handler: (windowId: number, ...args: InvokeContracts[C]['args']) => InvokeContracts[C]['result'] | Promise<InvokeContracts[C]['result']>) => {
    cleanup.push(handleForWindow(channel, trusted, (windowId, ...args) => { arity(args, count); return handler(windowId, ...args); }));
  };
  register('remote:hosts', 0, () => remote.hosts());
  register('remote:choose-file', 1, async (windowId, kind) => {
    if (kind !== 'identity' && kind !== 'config') throw new Error('Invalid SSH file kind');
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.id === windowId);
    if (!window || window.isDestroyed()) throw new Error('Window is no longer available');
    const result = await dialog.showOpenDialog(window, { title: kind === 'identity' ? 'Choose SSH identity' : 'Choose SSH config',
      defaultPath: join(homedir(), '.ssh'), properties: ['openFile', 'showHiddenFiles'],
    });
    if (window.isDestroyed() || result.canceled || !result.filePaths[0]) return null;
    const path = result.filePaths[0]; remote.grantFile(kind, path); return path;
  });
  register('remote:save-host', 2, (_window, input, id) => remote.saveHost(input, id));
  register('remote:remove-host', 1, (_window, id) => remote.removeHost(id));
  register('environment:status', 0, window => remote.snapshot(window));
  register('environment:select', 1, (window, input) => remote.select(window, input));
  register('environment:context', 2, (window, input, expected) => remote.saveContext(window, input, expected));
  register('environment:backend-status', 0, window => remote.backendStatus(window, backend.snapshot()));
  register('remote:retry', 0, window => remote.retry(window));
  register('remote:pause', 0, window => remote.disconnect(window, true));
  register('remote:disconnect', 0, window => remote.disconnect(window));
  register('remote:answer', 2, (window, id, answer) => remote.answer(window, id, answer));
  register('remote:add-forward', 1, (window, input) => remote.addForward(window, input));
  register('remote:retry-forward', 1, (window, id) => remote.retryForward(window, id));
  register('remote:remove-forward', 1, (window, id) => remote.removeForward(window, id));
  register('remote:diagnostics', 0, window => remote.diagnostics(window));
  return () => { for (const stop of cleanup) stop(); };
}
