import { SESSION_CHAT_STREAM_FRAME_BYTES, type SessionChatWatch } from '@elevenex/shared';
import { chatObject, parseChatPageWindow, parseChatState } from './session-chat-validation';
import { invalidResponse } from './transport';

export function chatEventId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9-]{36}:\d{1,12}:\d{1,12}$/.test(value);
}

interface ChatEventFrame {
  readonly id: string;
  readonly json: string;
}

/** The chat endpoint writes one UTF-8 JSON data line per named SSE event.
 * Buffer individual lines across chunks, with a cap before decoding or parsing. */
export async function* readChatEventFrames(
  body: ReadableStream<Uint8Array>,
  received: () => void,
): AsyncGenerator<ChatEventFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let partial = Buffer.alloc(0);
  let partialSize = 0;
  let frameSize = 0;
  const lines: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return; // EOF in a frame cannot advance the applied cursor.
      if (!value.byteLength) continue;
      received();
      const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      let start = 0;
      while (start < bytes.length) {
        const newline = bytes.indexOf(10, start);
        const end = newline < 0 ? bytes.length : newline + 1;
        frameSize += end - start;
        if (frameSize > SESSION_CHAT_STREAM_FRAME_BYTES) throw invalidResponse();
        let segment = bytes.subarray(start, newline < 0 ? end : newline);
        start = end;
        if (partialSize || newline < 0) {
          const needed = partialSize + segment.length;
          if (needed > partial.length) {
            const grown = Buffer.alloc(Math.min(SESSION_CHAT_STREAM_FRAME_BYTES, Math.max(needed, partial.length * 2, 256)));
            partial.copy(grown, 0, 0, partialSize);
            partial = grown;
          }
          segment.copy(partial, partialSize);
          partialSize = needed;
          segment = partial.subarray(0, needed);
        }
        if (newline < 0) continue;
        let line: string;
        try { line = decoder.decode(segment); }
        catch { throw invalidResponse(); }
        partialSize = 0;
        if (partial.length > 64 * 1024) partial = Buffer.alloc(0);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.startsWith(':')) continue;
        if (line) {
          if (lines.length === 3) throw invalidResponse();
          lines.push(line);
          continue;
        }
        frameSize = 0;
        if (!lines.length) continue;
        const [id, event, data] = lines;
        lines.length = 0;
        if (!id?.startsWith('id: ') || event !== 'event: chat' || !data?.startsWith('data: '))
          throw invalidResponse();
        yield { id: id.slice(4), json: data.slice(6) };
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function parseChatStreamPage(frame: ChatEventFrame, watch: SessionChatWatch, after?: string, first = true) {
  if (!chatEventId(frame.id) || frame.id === after) throw invalidResponse();
  let payload: unknown;
  try { payload = JSON.parse(frame.json); }
  catch { throw invalidResponse(); }
  const raw = chatObject(payload);
  if (raw['after'] !== (after ?? null)) throw invalidResponse();
  const data = chatObject(raw['page']);
  const page = parseChatPageWindow(data, watch.taskId, watch.sessionId, watch.loadingMode, watch.loadingMode === 'progressive', true);
  if (page.cursor !== frame.id || page.next !== null ||
      (page.reset ? page.events.length !== 0 : !after || page.items.length !== 0 || page.leadingPrompt !== undefined))
    throw invalidResponse();
  if (after) {
    const [previousFeed, previousSequence, previousHistory] = after.split(':');
    const [feed, sequence, history] = frame.id.split(':');
    if ((feed === previousFeed && Number(sequence) <= Number(previousSequence)) ||
        (!page.reset && (feed !== previousFeed || history !== previousHistory)))
      throw invalidResponse();
  }
  const ids = new Set<string>();
  for (const item of page.items) {
    if (ids.has(item.id)) throw invalidResponse();
    ids.add(item.id);
  }
  for (const event of page.events) {
    if (event.type === 'reset' || (event.type === 'delta' && !event.text)) throw invalidResponse();
    const id = event.type === 'item' ? event.item.id : event.id;
    if (ids.has(id)) throw invalidResponse();
    ids.add(id);
  }
  const state = first || page.reset || data['state'] !== undefined ? parseChatState(data['state']) : undefined;
  return { ...page, ...(state ? { state } : {}) };
}
