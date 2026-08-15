import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';

export interface AcpIncomingRequest {
  id: number | string;
  method: string;
  params: unknown;
}

export interface AcpIncomingNotification {
  method: string;
  params: unknown;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** JSON-RPC error codes we send back to the agent. */
export const ACP_ERROR_INTERNAL = -32603;
export const ACP_ERROR_METHOD_NOT_FOUND = -32601;

/**
 * Newline-delimited JSON-RPC 2.0 transport for the Agent Client Protocol.
 *
 * Unlike the Codex app-server — which omits the `jsonrpc` header on the wire —
 * ACP is strict JSON-RPC 2.0, so every outgoing frame carries
 * `"jsonrpc": "2.0"`.
 *
 * This class knows nothing about ACP semantics; it only frames messages,
 * correlates responses, and surfaces agent→client requests and notifications
 * as events:
 *
 * - `request`      — agent→client call that MUST be answered (respond/rejectRequest)
 * - `notification` — agent→client one-way message
 * - `closed`       — the underlying streams went away; every pending call is rejected
 */
export class AcpConnection extends EventEmitter {
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private closed = false;
  private closeError: Error | null = null;

  constructor(
    private readonly stdin: NodeJS.WritableStream,
    stdout: NodeJS.ReadableStream,
    private readonly defaultTimeoutMs = 60_000,
  ) {
    super();
    this.attachReader(stdout);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        this.closeError ?? new Error('Gemini ACP connection is closed.'),
      );
    }
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(
          new Error(
            `Gemini ACP request "${method}" timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      // Long-running calls (session/prompt) must not keep the event loop alive
      // on their own; the child process already does that.
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params }, (error) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(error);
      });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', method, params });
  }

  respondToRequest(id: number | string, result: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', id, result });
  }

  rejectRequest(
    id: number | string,
    message: string,
    code = ACP_ERROR_INTERNAL,
  ): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /** Rejects every in-flight request and stops accepting new ones. */
  close(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(error);
    }
    this.emit('closed', error);
  }

  private write(payload: unknown, onError?: (error: Error) => void): void {
    const line = `${JSON.stringify(payload)}\n`;
    try {
      this.stdin.write(line, (error) => {
        if (error && onError) onError(error);
      });
    } catch (error) {
      // A dead child reports `writable === true` for a tick, so a synchronous
      // throw here is possible; surface it the same way as an async failure
      // instead of letting it escape into the caller's stack.
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      if (onError) onError(normalized);
    }
  }

  /**
   * Splits stdout into lines. Uses an explicit StringDecoder rather than
   * `readline` so multi-byte UTF-8 sequences split across chunk boundaries
   * survive, and so trailing `\r` from Windows shims is stripped.
   */
  private attachReader(stream: NodeJS.ReadableStream): void {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      while (true) {
        const index = buffer.indexOf('\n');
        if (index === -1) break;
        let line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        this.handleLine(line);
      }
    });
    stream.on('end', () => {
      buffer += decoder.end();
      if (buffer.trim()) {
        this.handleLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
      }
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return;
      message = parsed as Record<string, unknown>;
    } catch {
      // gemini-cli occasionally prints non-protocol noise to stdout before the
      // handshake settles; dropping it is preferable to killing the session.
      this.emit('noise', line.slice(0, 500));
      return;
    }

    const id = message['id'];
    const method = message['method'];
    const hasId = typeof id === 'number' || typeof id === 'string';

    if (hasId && typeof method === 'string') {
      this.emit('request', {
        id,
        method,
        params: message['params'],
      } satisfies AcpIncomingRequest);
      return;
    }

    if (hasId) {
      // Outgoing ids are always numbers we allocated, so a response carrying a
      // string id is not ours to correlate.
      if (typeof id !== 'number') return;
      const entry = this.pending.get(id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      const error = message['error'];
      if (error) {
        entry.reject(new Error(describeAcpError(error, entry.method)));
      } else {
        entry.resolve(message['result']);
      }
      return;
    }

    if (typeof method === 'string') {
      this.emit('notification', {
        method,
        params: message['params'],
      } satisfies AcpIncomingNotification);
    }
  }
}

/**
 * Gemini nests upstream API failures as a JSON string inside `error.message`,
 * sometimes two levels deep, e.g.
 * `{"error":{"message":"{\"error\":{\"message\":\"API key not valid...\"}}"}}`.
 * Unwrap it so the workspace shows "API key not valid." rather than a wall of
 * escaped JSON.
 */
export function describeAcpError(error: unknown, method: string): string {
  const fallback = `Gemini ACP request "${method}" failed`;
  if (!error || typeof error !== 'object') return fallback;

  let message = (error as Record<string, unknown>)['message'];
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof message !== 'string') break;
    const trimmed = message.trim();
    if (!trimmed.startsWith('{')) break;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const inner = (parsed as Record<string, unknown> | null)?.['error'];
      const next =
        inner && typeof inner === 'object'
          ? (inner as Record<string, unknown>)['message']
          : undefined;
      if (typeof next !== 'string') break;
      message = next;
    } catch {
      break;
    }
  }

  return typeof message === 'string' && message.trim() ? message : fallback;
}
