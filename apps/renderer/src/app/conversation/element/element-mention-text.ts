import { elementMarker } from '@elevenex/shared';
import type { ConversationAttachment } from '../conversation.models';
import { splitElementLabel } from './element-geometry';

/** Native textarea labels are a view of the existing durable marker protocol. */
export function elementMentionNames(files: readonly Pick<ConversationAttachment, 'element' | 'marker'>[]): ReadonlyMap<number, string> {
  const names = new Map<number, string>();
  const used = new Set<string>();
  for (const file of [...files].sort((a, b) => (a.marker ?? 0) - (b.marker ?? 0))) {
    if (!file.element || !file.marker) continue;
    const label = splitElementLabel(file.element.label).name.replace(/[\r\n]+/g, ' ').replace(/[“”]/g, '"');
    let name = `@“${label}”`;
    // Only equal labels need a qualifier; identity still comes from the marker.
    let qualifier = 2;
    while (used.has(name)) name = `@“${label} · ${qualifier++}”`;
    used.add(name);
    names.set(file.marker, name);
  }
  return names;
}

export function displayElementMentions(text: string, names: ReadonlyMap<number, string>): string {
  const labels = new Map([...names].map(([marker, name]) => [elementMarker(marker), name]));
  return Array.from(text, char => labels.get(char) ?? char).join('');
}

export interface ElementTextPart { readonly text: string; readonly marker?: number }

/** Match whole labels only. A partly edited label becomes ordinary text. */
export function elementMentionParts(text: string, names: ReadonlyMap<number, string>): readonly ElementTextPart[] {
  const parts: ElementTextPart[] = [];
  const entries = [...names].sort((a, b) => b[1].length - a[1].length);
  let start = 0;
  let run = '';
  while (start < text.length) {
    const match = entries.find(([, name]) => text.startsWith(name, start));
    if (!match) { run += text[start++]; continue; }
    if (run) parts.push({ text: run });
    run = '';
    parts.push({ text: match[1], marker: match[0] });
    start += match[1].length;
  }
  if (run) parts.push({ text: run });
  return parts;
}

export function encodeElementMentions(text: string, names: ReadonlyMap<number, string>): string {
  return elementMentionParts(text, names).map(part => part.marker ? elementMarker(part.marker) : part.text).join('');
}
