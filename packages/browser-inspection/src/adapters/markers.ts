import type { ProbeHelpers, SourceCandidate } from './types';

/** Compiler/inspector interoperability. Read only these explicit source-metadata attributes. */
export function markerSources(element: Element, { attribute }: ProbeHelpers): readonly SourceCandidate[] {
  const result: SourceCandidate[] = [];
  const angular = attribute(element, 'data-ng-source-location');
  const ng = angular ? /^(.+)@o:\d+,l:(\d+),c:(\d+)$/.exec(angular) : null;
  if (ng) result.push({ type: 'location', file: ng[1]!, line: Number(ng[2]) + 1, column: Number(ng[3]) + 1, kind: 'angular-template' });
  for (const name of ['data-elevenex-source', 'data-v-inspector', 'data-insp-path']) {
    const value = attribute(element, name);
    // Greedy file group preserves Windows drive letters. Code Inspector may append a tag.
    const match = value ? /^(.+):(\d+):(\d+)(?::[a-z][a-z0-9-]*)?$/.exec(value) : null;
    if (match) result.push({ type: 'location', file: match[1]!, line: Number(match[2]), column: Number(match[3]), kind: name === 'data-v-inspector' ? 'vue-inspector' : 'source-marker' });
  }
  return result;
}
