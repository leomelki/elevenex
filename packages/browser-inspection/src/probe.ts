/** Runs only in the unprivileged page's MAIN world: isolated worlds cannot see Fiber expandos.
 * Read debug metadata without invoking components or collecting props, state or DOM text.
 * Keep this function closure-free; both Electron and Playwright execute its serialized body. */
function probe(selector: string): unknown {
  const own = (object: unknown, key: string): unknown => {
    if (!object || (typeof object !== 'object' && typeof object !== 'function')) return undefined;
    return Object.getOwnPropertyDescriptor(object, key)?.value;
  };
  const node = document.querySelector(selector);
  if (!node || node.closest('input,textarea,select,iframe,object,embed,[contenteditable]') || node.shadowRoot) return [];
  const result: { file?: string; line?: number; column?: number; stack?: string }[] = [];
  const visited = new Set<unknown>();
  let element: Element | null = node;
  for (let depth = 0; element && depth < 8; depth++, element = element.parentElement) {
    // Limit the number of keys examined; never collect page expando values in bulk.
    let key: string | undefined, examined = 0;
    for (const candidate in element) {
      if (++examined > 256) break;
      if (candidate.startsWith('__reactFiber$') || candidate.startsWith('__reactInternalInstance$')) { key = candidate; break; }
    }
    let fiber: unknown = key ? own(element, key) : undefined;
    for (let hops = 0; fiber && hops < 40 && result.length < 6; hops++) {
      if (visited.has(fiber)) break;
      visited.add(fiber);
      const source = own(fiber, '_debugSource');
      const file = own(source, 'fileName'), line = own(source, 'lineNumber'), column = own(source, 'columnNumber');
      if (typeof file === 'string' && file.length <= 2048 && typeof line === 'number') {
        result.push({ file, line, ...(typeof column === 'number' ? { column } : {}) });
      }
      const stack = own(fiber, '_debugStack');
      // V8 Error.stack is a lazy own accessor. Reading it does not run the component.
      if (stack instanceof Error) {
        try { const text = stack.stack; if (typeof text === 'string') result.push({ stack: text.slice(0, 8192) }); } catch { /* Untrusted accessor. */ }
      }
      fiber = own(fiber, '_debugOwner') ?? own(fiber, 'return');
    }
    if (result.length) break;
  }
  return result.slice(0, 6);
}

export function sourceProbeExpression(selector: string): string {
  return `(${probe.toString()})(${JSON.stringify(selector)})`;
}

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
