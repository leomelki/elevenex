import type { ProbeHelpers, SourceCandidate } from './types';

export function svelteSources(element: Element, { own }: ProbeHelpers): readonly SourceCandidate[] {
  const loc = own(own(element, '__svelte_meta'), 'loc');
  const file = own(loc, 'file'), line = own(loc, 'line'), column = own(loc, 'column');
  if (typeof file !== 'string' || file.length > 2048 || typeof line !== 'number' || typeof column !== 'number') return [];
  // Svelte 3/4 add_location includes a character offset and zero-based line.
  // Svelte 5 add_locations omits char and uses a one-based line. Both use zero-based columns.
  const legacy = typeof own(loc, 'char') === 'number';
  return [{ type: 'location', file, line: line + (legacy ? 1 : 0), column: column + 1, kind: 'svelte-metadata' }];
}
