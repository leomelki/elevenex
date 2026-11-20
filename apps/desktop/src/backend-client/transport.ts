import type { BackendClientError, BackendInfo } from '@elevenex/shared';
import { traceSessionChatRequest } from './session-chat-request-debug';

export interface BackendEndpoint {
  readonly url: string;
  readonly version: string;
  readonly headers: Readonly<Record<string, string>>;
}
export class BackendRequestError extends Error {
  constructor(readonly detail: BackendClientError) {
    super(detail.message);
  }
}

/** Main-owned operation paths only. Renderer requests never choose transport details. */
export async function requestBackendJson(
  endpoint: BackendEndpoint,
  operation: {
    readonly path: string;
    readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    readonly body?: unknown;
    readonly limit?: number;
    /** Known domain codes map to fixed adapter text; server messages stay private. */
    readonly conflictMessages?: Readonly<Record<string, string>>;
  },
  signal: AbortSignal,
): Promise<unknown> {
  const origin = new URL(endpoint.url);
  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    !origin.port ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    !operation.path.startsWith('/api/')
  ) {
    throw new BackendRequestError({
      code: 'transport',
      message: 'Backend endpoint is unavailable.',
    });
  }
  const url = new URL(operation.path, origin);
  const method = operation.method ?? 'GET';
  const trace = traceSessionChatRequest(method, url);
  let response: Response | undefined;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...endpoint.headers,
        Accept: 'application/json',
        ...(operation.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      ...(operation.body === undefined
        ? {}
        : { body: JSON.stringify(operation.body) }),
      signal,
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
    });
    if (!response.ok) {
      let conflictMessage =
        'The operation conflicts with the current workspace state.';
      if (response.status === 409 && operation.conflictMessages) {
        try {
          const error: unknown = await readResponseJson(response, 4096);
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            typeof error.code === 'string' &&
            Object.hasOwn(operation.conflictMessages, error.code)
          ) {
            conflictMessage =
              operation.conflictMessages[error.code] ?? conflictMessage;
          }
        } catch {
          // A malformed or oversized error body cannot hide the HTTP rejection.
        }
      }
      throw new BackendRequestError({
        code: 'http',
        message:
          response.status === 409
            ? conflictMessage
            : response.status === 404
              ? 'The selected resource no longer exists.'
              : 'Backend request failed.',
        status: response.status,
      });
    }
    const value = await readResponseJson(response, operation.limit ?? 256 * 1024, trace?.countBytes);
    trace?.finish('ok', response.status, value);
    return value;
  } catch (error) {
    trace?.finish(signal.aborted ? 'aborted' : error instanceof BackendRequestError ? error.detail.code : 'transport', response?.status);
    throw error;
  } finally {
    if (response?.body && !response.body.locked)
      await response.body.cancel().catch(() => undefined);
  }
}

async function readResponseJson(
  response: Response,
  limit: number,
  countBytes?: (bytes: number) => void,
): Promise<unknown> {
  if (
    !response.headers
      .get('content-type')
      ?.split(';')[0]
      ?.trim()
      .toLowerCase()
      .endsWith('/json')
  )
    throw invalidResponse();
  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > limit)
  )
    throw invalidResponse();
  if (!response.body) throw invalidResponse();
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw invalidResponse();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  countBytes?.(size);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw invalidResponse();
  }
}
export async function readBackendInfo(
  endpoint: BackendEndpoint,
  signal: AbortSignal,
): Promise<BackendInfo> {
  const value = await requestBackendJson(
    endpoint,
    { path: '/api/info', limit: 16 * 1024 },
    signal,
  );
  if (
    typeof value !== 'object' ||
    value === null ||
    !('backendSha' in value) ||
    typeof value.backendSha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value.backendSha) ||
    value.backendSha !== endpoint.version
  )
    throw invalidResponse();
  return { backendSha: value.backendSha };
}
export function invalidResponse(): BackendRequestError {
  return new BackendRequestError({
    code: 'invalid-response',
    message: 'Backend returned an incompatible response.',
  });
}
