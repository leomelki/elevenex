import { setTimeout as delay } from 'node:timers/promises';
import type { BackendClientError, SessionChatStreamEvent, SessionChatStreamUpdate, SessionChatWatch } from '@elevenex/shared';
import { parseChatStreamPage, readChatEventFrames } from './session-chat-stream-reader';
import { BackendRequestError, backendOperationUrl, invalidResponse, type BackendEndpoint } from './transport';

interface ChatStreamLease {
  readonly endpoint: BackendEndpoint;
  readonly signal: AbortSignal;
  release(): void;
}

type ChatStreamPacket =
  | Pick<Extract<SessionChatStreamEvent, { type: 'page' }>, 'type' | 'delivery' | 'page'>
  | { readonly type: 'reconnecting' }
  | { readonly type: 'closed'; readonly error: BackendClientError };

const TRANSPORT_ERROR: BackendClientError = { code: 'transport', message: 'The conversation connection was interrupted.' };
const ACK_TIMEOUT: BackendClientError = { code: 'unavailable', message: 'The conversation stopped receiving updates. Refresh to reconnect.' };

function canReconnect(error: BackendClientError): boolean {
  return error.code === 'transport' || error.code === 'timeout' ||
    (error.code === 'http' && (error.status === 408 || error.status === 429 || (error.status ?? 0) >= 500));
}

/** One main-owned stream per window. A single credit covers parsing, IPC and
 * applying the page, so reconnects can resume from the exact consumed cursor. */
export class SessionChatConnection {
  private after: string | undefined;
  private delivery = 0;
  private pending?: { readonly delivery: number; finish(error?: BackendRequestError): void };
  private closed = false;
  private reconnecting = false;
  private failures = 0;
  private readonly abort = () => this.close();

  constructor(
    readonly scopeId: string,
    readonly watch: SessionChatWatch,
    private readonly lease: ChatStreamLease,
    private readonly emit: (packet: ChatStreamPacket) => void,
    private readonly released: () => void,
  ) {
    this.after = watch.after;
  }

  start(): void {
    this.lease.signal.addEventListener('abort', this.abort, { once: true });
    void this.run().then(() => this.close(), () => this.close());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lease.signal.removeEventListener('abort', this.abort);
    this.pending?.finish();
    this.lease.release();
    this.released();
  }

  acknowledge(delivery: number): void {
    if (this.pending?.delivery === delivery) this.pending.finish();
  }

  private async run(): Promise<void> {
    const { signal } = this.lease;
    while (!signal.aborted) {
      const began = Date.now();
      let error = TRANSPORT_ERROR;
      try {
        await this.consume();
      } catch (issue) {
        if (issue instanceof BackendRequestError) error = issue.detail;
      }
      if (signal.aborted) return;
      if (!canReconnect(error)) {
        this.emit({ type: 'closed', error });
        return;
      }
      if (!this.reconnecting) {
        this.reconnecting = true;
        this.emit({ type: 'reconnecting' });
      }
      // An accepted connection that closes immediately can still be failing.
      // Reset backoff on actual output or sustained liveness.
      if (Date.now() - began >= 15_000) this.failures = 0;
      const ceiling = Math.min(15_000, 400 * 2 ** Math.min(this.failures++, 6));
      await delay(Math.round(ceiling * (0.5 + Math.random() * 0.5)), undefined, { signal }).catch(() => undefined);
    }
  }

  private async consume(): Promise<void> {
    const { endpoint, signal: leaseSignal } = this.lease;
    const { taskId, sessionId, loadingMode } = this.watch;
    const connection = new AbortController();
    const signal = AbortSignal.any([leaseSignal, connection.signal]);
    const query = new URLSearchParams({ loadingMode });
    const url = backendOperationUrl(endpoint, `/api/desktop-workspace/tasks/${taskId}/sessions/${sessionId}/chat/events?${query}`);
    let response: Response | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => connection.abort(), 45_000);
    const watchIdle = (ms = 40_000) => {
      clearTimeout(idle);
      idle = setTimeout(() => connection.abort(), ms);
    };
    try {
      watchIdle(15_000);
      response = await fetch(url, {
        headers: { ...endpoint.headers, Accept: 'text/event-stream', ...(this.after ? { 'Last-Event-ID': this.after } : {}) },
        signal, redirect: 'error', cache: 'no-store', credentials: 'omit',
      });
      if (response.status !== 200) {
        throw new BackendRequestError({ code: 'http', status: response.status, message:
          response.status === 410 ? 'This conversation was archived.'
            : response.status === 404 ? 'The selected conversation is unavailable.'
            : 'Could not open the conversation stream.',
        });
      }
      if (!response.body || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream')
        throw invalidResponse();
      watchIdle();
      let first = true;
      for await (const frame of readChatEventFrames(response.body, watchIdle)) {
        clearTimeout(deadline);
        clearTimeout(idle);
        if (signal.aborted) return;
        const page = parseChatStreamPage(frame, this.watch, this.after, first);
        await this.deliver(page);
        if (signal.aborted) return;
        this.after = page.cursor;
        this.reconnecting = false;
        if (page.events.length) this.failures = 0;
        first = false;
        watchIdle();
      }
    } finally {
      clearTimeout(deadline);
      clearTimeout(idle);
      connection.abort();
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
    }
  }

  private deliver(page: SessionChatStreamUpdate): Promise<void> {
    return new Promise((resolve, reject) => {
      const delivery = ++this.delivery;
      const finish = (error?: BackendRequestError) => {
        clearTimeout(timeout);
        this.pending = undefined;
        if (error) reject(error);
        else resolve();
      };
      // If a document stops acknowledging IPC, release the stream. Replaying
      // an unconfirmed append to that same document could duplicate its text.
      const timeout = setTimeout(() => finish(new BackendRequestError(ACK_TIMEOUT)), 45_000);
      this.pending = { delivery, finish };
      try { this.emit({ type: 'page', delivery, page }); }
      catch { finish(new BackendRequestError(ACK_TIMEOUT)); }
    });
  }
}
