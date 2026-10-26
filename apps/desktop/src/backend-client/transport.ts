import type { BackendClientError, BackendInfo } from '@elevenex/shared';

export interface BackendEndpoint {
  readonly url: string;
  readonly version: string;
  readonly headers: Readonly<Record<string, string>>;
}

export class BackendRequestError extends Error {
  constructor(readonly detail: BackendClientError) { super(detail.message); }
}

const infoLimit = 16 * 1024;

/** Main-only adapter for the existing GET /api/info wire format. No caller URL. */
export async function readBackendInfo(endpoint: BackendEndpoint, signal: AbortSignal): Promise<BackendInfo> {
  const origin = new URL(endpoint.url);
  // Both the owned backend and authenticated SSH tunnel bind IPv4 loopback.
  // Reject credentials, paths and redirects before sending a private capability.
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new BackendRequestError({ code: 'transport', message: 'Backend endpoint is unavailable.' });
  }
  const response = await fetch(new URL('/api/info', origin), {
    method: 'GET', headers: { ...endpoint.headers, Accept: 'application/json' },
    signal, redirect: 'error', cache: 'no-store', credentials: 'omit',
  });
  try {
    if (!response.ok) throw new BackendRequestError({ code: 'http', message: 'Backend request failed.', status: response.status });
    if (!response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase().endsWith('/json')) {
      throw invalidResponse();
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > infoLimit)) throw invalidResponse();
    if (!response.body) throw invalidResponse();
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > infoLimit) throw invalidResponse();
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw invalidResponse(); }
    if (typeof value !== 'object' || value === null || !('backendSha' in value)
      || typeof value.backendSha !== 'string' || !/^[a-f0-9]{40}$/.test(value.backendSha)
      || value.backendSha !== endpoint.version) throw invalidResponse();
    // Map explicitly: future server fields never leak through IPC accidentally.
    return { backendSha: value.backendSha };
  } finally {
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
  }
}

function invalidResponse(): BackendRequestError {
  return new BackendRequestError({ code: 'invalid-response', message: 'Backend returned an incompatible response.' });
}
