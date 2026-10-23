import { WebSocket } from 'ws';

// Per client, including the next payload. Replay remains owned by each producer;
// this layer must never create another output queue for a slow connection.
export const MAX_WEBSOCKET_BUFFERED_BYTES = 1024 * 1024;

const disconnected = new WeakSet<WebSocket>();

export function sendBounded(client: WebSocket, data: string | Buffer): boolean {
  if (client.readyState !== WebSocket.OPEN || disconnected.has(client)) {
    return false;
  }

  const disconnect = () => {
    if (disconnected.has(client) || client.readyState !== WebSocket.OPEN)
      return;
    disconnected.add(client);
    // A close frame would sit behind the stalled output. Terminate releases the
    // queue immediately and lets existing reconnect/replay behavior recover.
    client.terminate();
  };
  const bytes =
    typeof data === 'string' ? Buffer.byteLength(data) : data.length;
  if (client.bufferedAmount + bytes > MAX_WEBSOCKET_BUFFERED_BYTES) {
    disconnect();
    return false;
  }

  try {
    client.send(data, (error) => {
      if (error) disconnect();
    });
    return true;
  } catch {
    disconnect();
    return false;
  }
}
