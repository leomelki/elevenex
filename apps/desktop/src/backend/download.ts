import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { BackendRelease } from './release';

export interface DownloadProgress {
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
}

export type Fetch = typeof fetch;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const RELEASE_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);

function validateUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !RELEASE_HOSTS.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Backend downloads require an approved HTTPS release host');
  }
  return url;
}

/** Validate every redirect, including redirects made by the release asset CDN. */
export async function releaseResponse(url: string, signal: AbortSignal, request: Fetch = fetch): Promise<Response> {
  for (let redirects = 0; redirects <= 5; redirects++) {
    const current = validateUrl(url);
    const response = await request(current, { signal, redirect: 'manual', headers: { 'Accept-Encoding': 'identity' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Release redirect has no destination');
      url = new URL(location, current).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Backend release download failed (HTTP ${response.status})`);
    }
    return response;
  }
  throw new Error('Too many backend release redirects');
}

export async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error('Empty response body');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) throw new Error('Response exceeds its size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function downloadBackend(
  release: BackendRelease, destination: string, signal: AbortSignal,
  progress: (value: DownloadProgress) => void, request: Fetch = fetch,
): Promise<string> {
  const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]);
  const checksumResponse = await releaseResponse(`${release.url}.sha256`, downloadSignal, request);
  // Accommodate sha256sum/shasum and PowerShell's UTF-8 BOM/CRLF output.
  const checksum = (await boundedBody(checksumResponse, 4096)).toString('utf8').replace(/^\uFEFF/, '').trim();
  const match = /^([a-f0-9]{64})[ \t]+\*?([^\r\n]+)$/i.exec(checksum);
  if (!match || match[2] !== release.archiveName) throw new Error('Invalid backend archive checksum file');
  const expected = match[1]?.toLowerCase();
  const response = await releaseResponse(release.url, downloadSignal, request);
  const header = response.headers.get('content-length');
  const total = header === null ? null : Number(header);
  if (total !== null && (!Number.isSafeInteger(total) || total <= 0 || total > MAX_ARCHIVE_BYTES)) {
    await response.body?.cancel();
    throw new Error('Invalid backend archive size');
  }
  if (!response.body) throw new Error('Empty backend archive');
  const file = await open(destination, 'wx', 0o600).catch(async (error: unknown) => {
    await response.body?.cancel();
    throw error;
  });
  const hash = createHash('sha256');
  let received = 0;
  let lastProgress = 0;
  try {
    for await (const chunk of response.body) {
      downloadSignal.throwIfAborted();
      received += chunk.length;
      if (received > MAX_ARCHIVE_BYTES || (total !== null && received > total)) throw new Error('Backend archive exceeds its size limit');
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) offset += (await file.write(chunk, offset, chunk.length - offset)).bytesWritten;
      if (Date.now() - lastProgress >= 200) {
        progress({ receivedBytes: received, totalBytes: total });
        lastProgress = Date.now();
      }
    }
    if (!received || (total !== null && received !== total)) throw new Error('Incomplete backend archive');
    const digest = hash.digest('hex');
    if (digest !== expected) throw new Error('Backend archive checksum mismatch');
    await file.sync();
    progress({ receivedBytes: received, totalBytes: total });
    return digest;
  } finally {
    await file.close();
  }
}
