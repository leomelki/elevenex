import { randomUUID } from 'node:crypto';
import { debuglog } from 'node:util';
import type { BackendClientError } from '@elevenex/shared';

const debug = debuglog('elevenex-chat');
const chatRoute = /^\/api\/desktop-workspace\/tasks\/(\d{1,16})\/sessions\/(\d{1,16})\/chat(?:\/(agent|attachments|catalog|changes|content|media|tool-details|turn-work))?$/;

function queryNumber(query: URLSearchParams, key: string): number | undefined {
  const value = query.get(key);
  return value !== null && /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' ? value as Readonly<Record<string, unknown>> : {};
}

/** Log only allowlisted metadata. Cursors, tool identifiers and bodies can contain transcript data. */
export function traceSessionChatRequest(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: URL) {
  if (!debug.enabled) return undefined;
  const match = chatRoute.exec(url.pathname);
  if (!match) return undefined;
  const [, taskId, sessionId, route] = match;
  const operation = route ?? (method === 'GET' ? 'history' : 'command');
  const query = url.searchParams;
  const mode = query.get('loadingMode');
  const request = {
    id: randomUUID(),
    method,
    operation,
    taskId: Number(taskId),
    sessionId: Number(sessionId),
    ...(operation === 'history' ? {
      direction: query.has('following') ? 'following' : query.has('before') ? 'before' : query.has('after') ? 'poll' : 'latest',
      mode: mode === 'window' || mode === 'progressive' ? mode : 'default',
      summarizeCompleted: query.get('summarizeCompleted') === '1',
      summarizeRecent: query.get('summarizeRecent') === '1',
    } : {}),
    ...(operation === 'history' || operation === 'turn-work' ? {
      deferToolDetails: query.get('deferToolDetails') === '1',
    } : {}),
    offset: queryNumber(query, 'offset'),
    limit: queryNumber(query, 'limit'),
    ...(operation === 'tool-details' ? { withResult: query.has('resultId') } : {}),
  };
  const start = performance.now();
  debug('request %j', request);
  let responseBytes: number | undefined;
  return {
    countBytes: (bytes: number) => { responseBytes = bytes; },
    finish(outcome: 'ok' | 'aborted' | BackendClientError['code'], status?: number, value?: unknown): void {
      const reply = object(value);
      const items = Array.isArray(reply['items']) ? reply['items'] : undefined;
      const events = Array.isArray(reply['events']) ? reply['events'] : undefined;
      const total = reply['total'], nextOffset = reply['nextOffset'];
      debug('response %j', {
        ...request,
        outcome,
        status,
        elapsedMs: Math.round(performance.now() - start),
        responseBytes,
        items: items?.length,
        events: events?.length,
        ...(operation === 'history' && outcome === 'ok' ? {
          completedTurns: items?.filter(item => object(item)['completedTurn'] !== undefined).length,
          reset: reply['reset'] === true,
          hasOlder: typeof reply['before'] === 'string',
          hasFollowing: typeof reply['next'] === 'string',
        } : {}),
        total: Number.isSafeInteger(total) ? total : undefined,
        nextOffset: nextOffset === null || Number.isSafeInteger(nextOffset) ? nextOffset : undefined,
      });
    },
  };
}
