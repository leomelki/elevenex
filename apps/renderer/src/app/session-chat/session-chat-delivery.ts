import type { BackendClientError, SessionChatTarget } from '@elevenex/shared';
import type { SessionChatClient } from '../backend/session-chat-client.service';

export function ambiguousChatDelivery(error: BackendClientError): boolean {
  return error.code === 'outcome-unknown' || error.code === 'stale-scope' || error.code === 'timeout';
}

/** A few indexed reads cover late acceptance without keeping a poller alive indefinitely. */
export async function checkChatDelivery(
  client: SessionChatClient, scope: string, target: SessionChatTarget, deliveryId: string, signal: AbortSignal, delays: readonly number[] = [0, 500, 1500, 4000],
): Promise<'accepted' | 'failed' | 'pending' | 'unknown'> {
  let pending = false;
  for (const delay of delays) {
    if (delay) await new Promise<void>(resolve => {
      if (signal.aborted) { resolve(); return; }
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, delay);
      signal.addEventListener('abort', finish, { once: true });
    });
    if (signal.aborted) break;
    const requestId = crypto.randomUUID();
    const cancel = () => client.cancel(scope, requestId);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = await client.delivery(scope, { taskId: target.taskId, sessionId: target.sessionId, deliveryId, requestId });
      if (signal.aborted) break;
      pending = result.ok && result.value.status === 'pending';
      if (result.ok) {
        if (result.value.status === 'accepted' || result.value.status === 'failed') return result.value.status;
        if (result.value.status === 'unconfirmed') break;
      } else if (result.error.code === 'stale-scope' || (result.error.code === 'http' && result.error.status === 404)) break;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
  return pending && !signal.aborted ? 'pending' : 'unknown';
}
