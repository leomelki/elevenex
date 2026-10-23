import { WebSocket } from 'ws';

// Per client, including the next payload. Replay remains owned by each producer;
// this layer must never create another output queue for a slow connection.
export const MAX_WEBSOCKET_BUFFERED_BYTES = 1024 * 1024;
export const MAX_AGENT_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_AGENT_LARGE_IN_FLIGHT_BYTES = 64 * 1024 * 1024;
export const MAX_AGENT_BUFFERED_BYTES =
  MAX_AGENT_LARGE_IN_FLIGHT_BYTES + MAX_WEBSOCKET_BUFFERED_BYTES;

const disconnected = new WeakSet<WebSocket>();

interface AgentInFlight {
  normalBytes: number;
  largeBytes: number;
  active: boolean;
  cleanup: () => void;
}

// Only counters and listeners; payloads are queued exclusively by ws.
const agentInFlight = new WeakMap<WebSocket, AgentInFlight>();

function disconnect(client: WebSocket): void {
  agentInFlight.get(client)?.cleanup();
  if (disconnected.has(client) || client.readyState !== WebSocket.OPEN) return;
  disconnected.add(client);
  // A close frame would sit behind stalled output. Terminate releases the queue
  // immediately and lets existing reconnect/replay behavior recover.
  client.terminate();
}

export function sendBounded(client: WebSocket, data: string | Buffer): boolean {
  if (client.readyState !== WebSocket.OPEN || disconnected.has(client)) {
    return false;
  }

  const bytes =
    typeof data === 'string' ? Buffer.byteLength(data) : data.length;
  if (client.bufferedAmount + bytes > MAX_WEBSOCKET_BUFFERED_BYTES) {
    disconnect(client);
    return false;
  }

  try {
    client.send(data, (error) => {
      if (error) disconnect(client);
    });
    return true;
  } catch {
    disconnect(client);
    return false;
  }
}

export type AgentFrameSendResult = 'sent' | 'unavailable' | 'oversized';

/**
 * Agent snapshots and large tool results are individual protocol frames, not
 * backlog. Reserve their bytes until the send callback, even if bufferedAmount
 * drops earlier, and exclude that reservation from the ordinary 1 MiB budget.
 * Two full-sized snapshots can coexist with deltas, within a hard 65 MiB total.
 * An oversized single frame is rejected without disconnecting a healthy peer.
 */
export function sendAgentFrame(
  client: WebSocket,
  data: string,
  snapshot = false,
): AgentFrameSendResult {
  if (client.readyState !== WebSocket.OPEN || disconnected.has(client)) {
    return 'unavailable';
  }
  const bytes = Buffer.byteLength(data);
  if (bytes > MAX_AGENT_FRAME_BYTES) return 'oversized';

  const existing = agentInFlight.get(client);
  const normalBytes = existing?.normalBytes ?? 0;
  const largeBytes = existing?.largeBytes ?? 0;
  const large = snapshot || bytes > MAX_WEBSOCKET_BUFFERED_BYTES;
  const backlog = Math.max(normalBytes, client.bufferedAmount - largeBytes, 0);
  const total = Math.max(client.bufferedAmount, normalBytes + largeBytes);
  // Charge empty frames too, so even their callbacks cannot accumulate forever.
  const charge = Math.max(bytes, 1);
  if (
    (large
      ? backlog >= MAX_WEBSOCKET_BUFFERED_BYTES ||
        largeBytes + charge > MAX_AGENT_LARGE_IN_FLIGHT_BYTES
      : backlog + charge > MAX_WEBSOCKET_BUFFERED_BYTES) ||
    total + charge > MAX_AGENT_BUFFERED_BYTES
  ) {
    disconnect(client);
    return 'unavailable';
  }

  const state = existing ?? trackAgentFrames(client);
  if (large) state.largeBytes += charge;
  else state.normalBytes += charge;
  let settled = false;
  const release = () => {
    if (settled || !state.active) return false;
    settled = true;
    if (large) state.largeBytes -= charge;
    else state.normalBytes -= charge;
    if (state.normalBytes === 0 && state.largeBytes === 0) state.cleanup();
    return true;
  };
  try {
    client.send(data, (error) => {
      const wasActive = release();
      if (error && wasActive) disconnect(client);
    });
    return 'sent';
  } catch {
    if (release()) disconnect(client);
    return 'unavailable';
  }
}

function trackAgentFrames(client: WebSocket): AgentInFlight {
  const onError = () => disconnect(client);
  const state: AgentInFlight = {
    normalBytes: 0,
    largeBytes: 0,
    active: true,
    cleanup: () => {
      if (!state.active) return;
      state.active = false;
      state.normalBytes = state.largeBytes = 0;
      agentInFlight.delete(client);
      client.off('close', state.cleanup);
      client.off('error', onError);
    },
  };
  agentInFlight.set(client, state);
  client.once('close', state.cleanup);
  client.once('error', onError);
  return state;
}
