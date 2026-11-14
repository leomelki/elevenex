import { angularSources } from './adapters/angular';
import { markerSources } from './adapters/markers';
import { reactSources } from './adapters/react';
import { svelteSources } from './adapters/svelte';
import { vueSources } from './adapters/vue';
import type { SourceAdapter, SourceCandidate } from './adapters/types';

/** Closure-free collector in the unprivileged MAIN world. Adapters never export runtime objects. */
function probe(selector: string, adapters: readonly SourceAdapter[]): unknown {
  const own = (object: unknown, key: string): unknown => {
    if (!object || (typeof object !== 'object' && typeof object !== 'function')) return undefined;
    return Object.getOwnPropertyDescriptor(object, key)?.value;
  };
  const attribute = (element: Element, name: string): string | undefined => {
    const value = element.getAttribute?.(name);
    return typeof value === 'string' && value.length <= 2304 ? value : undefined;
  };
  const node = document.querySelector(selector);
  if (!node || node.closest('input,textarea,select,iframe,object,embed,[contenteditable]') || node.shadowRoot) return [];
  const result: (SourceCandidate & { readonly depth: number })[] = [];
  let element: Element | null = node;
  for (let depth = 0; element && depth < 8 && result.length < 12; depth++, element = element.parentElement) {
    for (const adapter of adapters) {
      try {
        for (const candidate of adapter(element, { own, attribute })) {
          if (result.length === 12) break;
          result.push({ ...candidate, depth });
        }
      } catch { /* A missing debug API, proxy or malformed adapter must not hide other metadata. */ }
    }
  }
  return result;
}

export function sourceProbeExpression(selector: string): string {
  // Explicit registry: adding a framework changes one adapter without mixing network or UI code.
  const adapters = [markerSources, svelteSources, reactSources, angularSources, vueSources];
  return `(${probe.toString()})(${JSON.stringify(selector)},[${adapters.map(adapter => adapter.toString()).join(',')}])`;
}
