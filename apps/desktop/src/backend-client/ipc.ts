import { handleForWindow, type TrustedSender } from '../ipc';
import type { BackendClient } from './client';

export function registerBackendClientIpc(client: BackendClient, trusted: TrustedSender): () => void {
  const stopState = handleForWindow('backend-client:state', trusted, (windowId, ...args) => {
    if (args.length !== 0) throw new Error('Backend client state accepts no arguments');
    return client.state(windowId);
  });
  const stopInfo = handleForWindow('backend-client:info', trusted, (windowId, ...args) => {
    if (args.length !== 1 || typeof args[0] !== 'string' || !/^[a-f0-9-]{36}$/.test(args[0])) {
      throw new Error('A backend scope id is required');
    }
    return client.info(windowId, args[0]);
  });
  return () => { stopState(); stopInfo(); };
}
