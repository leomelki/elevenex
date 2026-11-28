import type { SessionChatWatch } from '@elevenex/shared';
import { handleForWindow, sendToWindow, type TrustedSender } from '../ipc';
import type { BackendClient } from './client';
import { SessionChatConnection } from './session-chat-stream';
import { chatEventId } from './session-chat-stream-reader';
import { chatId, chatObject, requestId } from './session-chat-validation';

function scopeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value))
    throw new Error('A backend scope is required.');
  return value;
}

export function registerSessionChatStreamIpc(client: BackendClient, trusted: TrustedSender): () => void {
  const streams = new Map<number, SessionChatConnection>();
  const find = (window: number, scope: string, watchId: string) => {
    if (client.state(window).scope?.id !== scope) return undefined;
    const stream = streams.get(window);
    return stream?.scopeId === scope && stream.watch.watchId === watchId ? stream : undefined;
  };
  const stops = [
    handleForWindow('session-chat:watch', trusted, (window, ...args) => {
      if (args.length !== 2) throw new Error('Invalid conversation stream arguments.');
      const scope = scopeId(args[0]);
      const raw = chatObject(args[1]);
      const loadingMode = raw['loadingMode'];
      const after = raw['after'];
      if ((loadingMode !== 'window' && loadingMode !== 'progressive') ||
          (after !== undefined && !chatEventId(after)))
        throw new Error('Invalid conversation stream view or cursor.');
      const watch: SessionChatWatch = {
        taskId: chatId(raw['taskId']), sessionId: chatId(raw['sessionId']),
        watchId: requestId(raw['watchId']), loadingMode, after,
      };
      const existing = find(window, scope, watch.watchId);
      if (existing) {
        if (existing.watch.taskId !== watch.taskId || existing.watch.sessionId !== watch.sessionId ||
            existing.watch.loadingMode !== watch.loadingMode || existing.watch.after !== watch.after)
          throw new Error('Conversation watch ID is already in use.');
        return { ok: true as const, value: { accepted: true as const } };
      }
      const lease = client.lease(window, scope);
      if (!lease.ok) return lease;
      streams.get(window)?.close();
      const connection = new SessionChatConnection(scope, watch, lease.value, packet => {
        if (find(window, scope, watch.watchId) === connection)
          sendToWindow(window, 'session-chat:stream', { ...packet, scopeId: scope, watchId: watch.watchId, taskId: watch.taskId, sessionId: watch.sessionId });
      }, () => {
        if (streams.get(window) === connection) streams.delete(window);
      });
      streams.set(window, connection);
      connection.start();
      return { ok: true as const, value: { accepted: true as const } };
    }),
    handleForWindow('session-chat:unwatch', trusted, (window, ...args) => {
      if (args.length !== 2) throw new Error('Invalid conversation stream arguments.');
      find(window, scopeId(args[0]), requestId(args[1]))?.close();
    }),
    handleForWindow('session-chat:acknowledge', trusted, (window, ...args) => {
      if (args.length !== 3 || !Number.isSafeInteger(args[2]) || args[2] < 1)
        throw new Error('Invalid conversation stream acknowledgement.');
      find(window, scopeId(args[0]), requestId(args[1]))?.acknowledge(args[2]);
    }),
  ];
  return () => {
    for (const stop of stops) stop();
    for (const stream of streams.values()) stream.close();
  };
}
