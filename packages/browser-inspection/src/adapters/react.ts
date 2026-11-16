import type { ProbeHelpers, SourceCandidate } from './types';

/** React 18 direct metadata / React 19 stacks. Never invoke components or read props/state. */
export function reactSources(element: Element, { own }: ProbeHelpers): readonly SourceCandidate[] {
  const result: SourceCandidate[] = [], visited = new Set<unknown>();
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
      result.push({ type: 'location', file, line, ...(typeof column === 'number' ? { column } : {}), kind: 'react-debug-source' });
    }
    const stack = own(fiber, '_debugStack');
    // V8 Error.stack is a lazy own accessor; this does not invoke the component.
    if (stack instanceof Error) {
      try { const text = stack.stack; if (typeof text === 'string') result.push({ type: 'stack', stack: text.slice(0, 8192) }); } catch { /* Untrusted accessor. */ }
    }
    fiber = own(fiber, '_debugOwner') ?? own(fiber, 'return');
  }
  return result.slice(0, 6);
}
