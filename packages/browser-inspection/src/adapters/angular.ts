import type { ProbeHelpers, SourceCandidate } from './types';

export function angularSources(element: Element, { own }: ProbeHelpers): readonly SourceCandidate[] {
  const ng = own(globalThis, 'ng');
  const getComponent = own(ng, 'getComponent'), getOwner = own(ng, 'getOwningComponent');
  // Invoke only Angular's named, read-only debug APIs. Never instantiate or render components.
  let instance: unknown;
  try { if (typeof getComponent === 'function') instance = getComponent(element); } catch { /* Try the owning view's supported API. */ }
  if (!instance && typeof getOwner === 'function') instance = getOwner(element);
  if (!instance || typeof instance !== 'object') return [];
  const constructor = own(Object.getPrototypeOf(instance), 'constructor');
  const debug = own(own(constructor, 'ɵcmp'), 'debugInfo');
  const file = own(debug, 'filePath'), line = own(debug, 'lineNumber');
  if (typeof file !== 'string' || file.length > 2048) return [];
  // This is the component class declaration, not the selected element's template line.
  return [{ type: 'component', file, framework: 'angular', ...(typeof line === 'number' ? { line } : {}) }];
}
