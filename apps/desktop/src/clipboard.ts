import { clipboard } from 'electron';
import { handleForWindow, type TrustedSender } from './ipc';

const maxTextBytes = 16 * 1024 * 1024;

/** Browser permissions stay denied; only trusted app main frames can copy text. */
export function registerClipboardIpc(trusted: TrustedSender): () => void {
  return handleForWindow('clipboard:write-text', trusted, (_windowId, ...args) => {
    if (args.length !== 1 || typeof args[0] !== 'string' ||
      args[0].length > maxTextBytes || Buffer.byteLength(args[0], 'utf8') > maxTextBytes) {
      throw new Error('Clipboard requires one text argument of at most 16 MiB');
    }
    // The default clipboard is the system clipboard, including on Linux where
    // the primary-selection clipboard is separate. Await native completion.
    return clipboard.writeText(args[0]);
  });
}
