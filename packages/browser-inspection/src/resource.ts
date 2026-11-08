/** Fetch through the inspected browser's existing network policy, never privileged Node fetch.
 * Same-origin only; no redirects/credentials, bounded decompressed bytes and an owned deadline. */
async function resource(url: string): Promise<unknown> {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.origin !== location.origin || target.username || target.password) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 650);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(target.href, { signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 2_097_152) return null;
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '', bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2_097_152) return null;
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { text, map: (response.headers.get('sourcemap') ?? response.headers.get('x-sourcemap') ?? '').slice(0, 2048) };
  } catch { return null; }
  finally { controller.abort(); clearTimeout(timer); await reader?.cancel().catch(() => undefined); }
}

export function sourceResourceExpression(url: string): string {
  return `(${resource.toString()})(${JSON.stringify(url)})`;
}
