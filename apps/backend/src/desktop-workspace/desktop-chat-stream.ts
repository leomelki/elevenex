import { once } from 'node:events';
import { SESSION_CHAT_STREAM_FRAME_BYTES, type SessionChatStreamPage } from '@elevenex/shared';
import type { Response } from 'express';

const HEARTBEAT_MS = 12_000;

/** A closed stream stops waiting for shared hydration without cancelling other readers. */
export async function waitForChatStreamWork<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  const closed = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, closed]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** The response owns cancellation for the whole stream, including writes to a slow peer. */
export async function sendDesktopChatStream(
  response: Response,
  open: (signal: AbortSignal) => Promise<AsyncIterable<SessionChatStreamPage>>,
): Promise<void> {
  const abort = new AbortController();
  const { signal } = abort;
  const close = () => abort.abort();
  response.once('close', close);
  response.once('error', close);
  if (response.destroyed) close();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const pages = await open(signal);
    if (signal.aborted) return;
    response.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    response.write(': connected\n\n');

    let lastWrite = Date.now();
    heartbeat = setInterval(() => {
      if (response.writableNeedDrain) {
        if (Date.now() - lastWrite >= 3 * HEARTBEAT_MS) response.destroy();
        return;
      }
      response.write(': keepalive\n\n');
      lastWrite = Date.now();
    }, HEARTBEAT_MS).unref();

    for await (const update of pages) {
      if (signal.aborted) break;
      const frame = `id: ${update.page.cursor}\nevent: chat\ndata: ${JSON.stringify(update)}\n\n`;
      if (Buffer.byteLength(frame) > SESSION_CHAT_STREAM_FRAME_BYTES) throw new Error('Conversation update exceeded its stream limit.');
      lastWrite = Date.now();
      if (!response.write(frame))
        await once(response, 'drain', { signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]) });
    }
    if (!signal.aborted) response.end();
  } catch (error) {
    if (signal.aborted) return;
    if (!response.headersSent) throw error;
    // A partial frame is discarded by the client. Its applied cursor is safe to resume.
    response.destroy();
  } finally {
    clearInterval(heartbeat);
    response.off('close', close);
    response.off('error', close);
    abort.abort();
  }
}
