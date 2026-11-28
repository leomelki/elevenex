import { WebSocket } from 'ws';
import type { BackendResult, TaskTerminalAttach, TaskTerminalStreamEvent, TaskTerminalStreamWrite } from '@elevenex/shared';
import type { BackendEndpoint } from './transport';
import { invalidResponse } from './transport';
import { parseTerminalStreamPacket } from './terminal-stream-validation';

const accepted = { ok: true as const, value: { accepted: true as const } };
const unavailable = (): BackendResult<never> => ({ ok: false, error: { code: 'unavailable', message: 'The terminal stream is unavailable. Reattach before typing.' } });

export interface TerminalStreamDiagnostic {
  readonly type: 'error' | 'close' | 'protocol' | 'server-closed';
  readonly detail: string;
  readonly code?: number;
  readonly phase?: 'handshake' | 'stream';
}

export interface TerminalStreamConnection {
  readonly ready: Promise<BackendResult<{ readonly accepted: true }>>;
  readonly target: TaskTerminalAttach;
  readonly scope: string;
  readonly socket: WebSocket;
  close(notify?: boolean): void;
  write(input: TaskTerminalStreamWrite): BackendResult<{ readonly accepted: true }>;
  acknowledge(delivery: number): void;
}

/** Owned transport only: no Electron objects or renderer-selected endpoints.
 * Credits, cursor validation and uncertain input outcomes span the whole lease. */
export function connectTerminalStream(
  scope: string, target: TaskTerminalAttach,
  lease: { readonly endpoint: BackendEndpoint; readonly signal: AbortSignal; release(): void },
  emit: (packet: TaskTerminalStreamEvent['packet']) => void,
  closedConnection: (connection: TerminalStreamConnection) => void,
  diagnose?: (diagnostic: TerminalStreamDiagnostic) => void,
): BackendResult<TerminalStreamConnection> {
    const { endpoint, signal, release } = lease;
    if (signal.aborted) { release(); return unavailable(); }
    let origin: URL;
    try { origin = new URL(endpoint.url); }
    catch { release(); return unavailable(); }
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
      release(); return unavailable();
    }
    const url = new URL('/desktop-terminal/v1', origin); url.protocol = 'ws:';
    url.search = new URLSearchParams({ taskId: String(target.taskId), terminalId: String(target.terminalId), after: String(target.after),
      ...(target.generation ? { generation: target.generation } : {}) }).toString();
    let socket: WebSocket;
    try { socket = new WebSocket(url, { headers: endpoint.headers, perMessageDeflate: false, maxPayload: 1024 * 1024, handshakeTimeout: 10000, followRedirects: false }); }
    catch { release(); return unavailable(); }
    let closed = false, ready = false, sentInput = 0, ackInput = 0, delivery = 0, acknowledged = 0, cursor = target.after;
    const report = (diagnostic: TerminalStreamDiagnostic) => {
      if (closed || !diagnose) return;
      // Diagnostics stay in main. Never include request URLs, headers or PTY
      // data, and redact capabilities echoed by an upstream close/error.
      let detail = diagnostic.detail;
      for (const value of Object.values(endpoint.headers ?? {})) if (value) detail = detail.replaceAll(value, '[redacted]');
      diagnose({ ...diagnostic, detail: detail.slice(0, 512) });
    };
    let currentGeneration = target.generation;
    let restoring: { sequence: number; size: string; length: number } | undefined;
    const inputSizes = new Map<number, number>(); let pendingBytes = 0;
    let settle!: (value: BackendResult<{ readonly accepted: true }>) => void;
    const result = new Promise<BackendResult<{ readonly accepted: true }>>(resolve => { settle = resolve; });
    const deadline = setTimeout(() => stream.close(true), 10000);
    let lastActivity = Date.now();
    // The server pings even when output/metadata is unchanged. A broken tunnel
    // or wedged engine must not leave an apparently live input sink forever.
    const heartbeat = setInterval(() => { if (Date.now() - lastActivity > 35000) stream.close(true); }, 15000);
    heartbeat.unref();
    const abort = () => stream.close();
    const stream: TerminalStreamConnection = {
      scope, target, socket, ready: result,
      close: (notify = false) => {
        if (closed) return;
        closed = true; clearTimeout(deadline); clearInterval(heartbeat); signal.removeEventListener('abort', abort);
        closedConnection(stream);
        if (notify) emit({ type: 'closed', uncertain: sentInput > ackInput, message: 'Terminal connection interrupted. Reattaching never replays input.' });
        settle(unavailable()); release(); socket.terminate(); inputSizes.clear();
      },
      write: input => {
        const bytes = Buffer.byteLength(input.data);
        if (!ready || closed || socket.readyState !== WebSocket.OPEN || input.generation !== currentGeneration ||
            input.sequence !== sentInput + 1 || pendingBytes + bytes > 128 * 1024 || socket.bufferedAmount > 256 * 1024) return unavailable();
        sentInput = input.sequence; pendingBytes += bytes; inputSizes.set(sentInput, bytes);
        socket.send(JSON.stringify({ type: 'input', kind: input.kind, sequence: sentInput, generation: input.generation, data: input.data }), error => { if (error) stream.close(true); });
        return accepted;
      },
      acknowledge: next => {
        if (next < acknowledged || next > delivery) throw new Error('Invalid terminal acknowledgement');
        if (closed || next === acknowledged) return;
        acknowledged = next; socket.send(JSON.stringify({ type: 'ack', delivery: next }));
      },
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { stream.close(); return unavailable(); }
    socket.on('message', (data, binary) => {
      if (closed) return;
      lastActivity = Date.now();
      let reason = 'binary-frame';
      try {
        if (binary) throw invalidResponse();
        reason = 'invalid-json';
        const raw: unknown = JSON.parse(data.toString());
        reason = 'invalid-packet';
        const packet = parseTerminalStreamPacket(raw, target.taskId, target.terminalId);
        if (packet.type === 'output' || packet.type === 'snapshot') {
          reason = 'delivery-order-or-credit-limit';
          if (packet.delivery !== ++delivery || delivery - acknowledged > 256) throw invalidResponse();
          if (packet.type === 'output') {
            reason = 'output-generation-or-cursor';
            if (restoring || packet.output.gap || packet.output.generation !== currentGeneration || packet.output.from !== cursor) throw invalidResponse();
            cursor = packet.output.next;
          } else {
            if (packet.first) {
              reason = 'overlapping-snapshot';
              if (restoring) throw invalidResponse();
              restoring = { sequence: packet.sequence, size: JSON.stringify(packet.size), length: 0 };
              currentGeneration = packet.terminal.generation;
            }
            reason = 'snapshot-generation-sequence-or-size';
            if (!restoring || restoring.sequence !== packet.sequence || restoring.size !== JSON.stringify(packet.size) || packet.terminal.generation !== currentGeneration) throw invalidResponse();
            restoring.length += packet.data.length;
            reason = 'snapshot-limit';
            if (restoring.length > 4 * 1024 * 1024) throw invalidResponse();
            if (packet.last) { cursor = packet.sequence; restoring = undefined; }
          }
        } else if (packet.type === 'input-ack') {
          reason = 'input-ack-sequence';
          if (packet.sequence <= ackInput || packet.sequence > sentInput) throw invalidResponse();
          ackInput = packet.sequence;
          for (const [sequence, size] of inputSizes) if (sequence <= ackInput) { pendingBytes -= size; inputSizes.delete(sequence); }
        }
        if (packet.type === 'closed') report({ type: 'server-closed', phase: ready ? 'stream' : 'handshake', detail: packet.message });
        if (!ready && packet.type === 'metadata') { ready = true; clearTimeout(deadline); settle(accepted); }
        reason = 'packet-dispatch';
        emit(packet);
        if (packet.type === 'closed') stream.close();
      } catch {
        // Use fixed reason codes, never parser errors containing raw PTY data.
        report({ type: 'protocol', phase: ready ? 'stream' : 'handshake', detail: reason });
        stream.close(true);
      }
    });
    socket.on('error', error => { report({ type: 'error', detail: error.message }); stream.close(true); });
    socket.on('close', (code, reason) => { report({ type: 'close', code, detail: reason.toString() }); stream.close(true); });
    socket.on('ping', () => { lastActivity = Date.now(); });
    return { ok: true, value: stream };
}
