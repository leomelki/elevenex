import { broadcast, handle, type TrustedSender } from '../ipc';
import type { BackendManager } from './manager';

/** No renderer input may choose a download, path, executable, or environment. */
export function registerBackendIpc(backend: BackendManager, trusted: TrustedSender): () => void {
  const noArguments = (args: readonly unknown[]) => {
    if (args.length !== 0) throw new Error('Backend operations accept no arguments');
  };
  handle('backend:status', trusted, (...args) => { noArguments(args); return backend.snapshot(); });
  handle('backend:retry', trusted, (...args) => { noArguments(args); return backend.start(); });
  handle('backend:restart', trusted, (...args) => { noArguments(args); return backend.restart(); });
  return backend.subscribe(status => broadcast('backend:changed', status));
}
