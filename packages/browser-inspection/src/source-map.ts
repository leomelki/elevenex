import { SourceMap } from 'node:module';
import type { BrowserSourceLocation } from '@elevenex/shared';
import { location, object } from './location';

/** Node's source-map consumer handles VLQ ranges; indexed maps are bounded and selected here.
 * Never guess that generated TSX line numbers equal original TSX line numbers. */
export function mappedSource(payload: unknown, line: number, column: number, base: string, depth = 0): BrowserSourceLocation | undefined {
  const raw = object(payload);
  if (!raw || raw['version'] !== 3 || !Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1 || depth > 4) return undefined;
  if (Array.isArray(raw['sections'])) {
    if (raw['sections'].length > 64) return undefined;
    let selected: { map: unknown; line: number; column: number } | undefined;
    let previousLine = -1, previousColumn = -1;
    for (const section of raw['sections']) {
      const item = object(section), offset = object(item?.['offset']);
      const startLine = offset?.['line'], startColumn = offset?.['column'];
      if (typeof startLine !== 'number' || typeof startColumn !== 'number' || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(startColumn) || startLine < 0 || startColumn < 0 || startLine < previousLine || (startLine === previousLine && startColumn <= previousColumn)) return undefined;
      previousLine = startLine; previousColumn = startColumn;
      if (startLine < line - 1 || (startLine === line - 1 && startColumn <= column - 1)) selected = { map: item?.['map'], line: startLine, column: startColumn };
    }
    return selected ? mappedSource(selected.map, line - selected.line, line - 1 === selected.line ? column - selected.column : column, base, depth + 1) : undefined;
  }
  const sources = raw['sources'], names = raw['names'] ?? [], mappings = raw['mappings'], root = raw['sourceRoot'] ?? '';
  if (!Array.isArray(sources) || sources.length > 20_000 || !sources.every(source => typeof source === 'string' && source.length <= 2048) || !Array.isArray(names) || names.length > 100_000 || !names.every(name => typeof name === 'string') || typeof mappings !== 'string' || mappings.length > 2_097_152 || typeof root !== 'string' || root.length > 2048) return undefined;
  try {
    // sourcesContent is deliberately discarded: resolution only needs mappings and identifiers.
    // Node's consumer does not apply sourceRoot; join it explicitly before decoding.
    const rooted = sources.map(source => root && !/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(source)
      ? root.replace(/\/?$/, '/') + source : source);
    const map = new SourceMap({ version: 3, file: '', sources: rooted, names, mappings, sourceRoot: '', sourcesContent: [] });
    const entry = map.findEntry(line - 1, column - 1);
    if (!('originalSource' in entry) || entry.generatedLine !== line - 1) return undefined;
    let file = entry.originalSource;
    // Relative map sources are URL-relative, never relative to this process's cwd.
    if (/^(?:\.\.?\/)/.test(file)) file = new URL(file, base).pathname;
    return location(file, entry.originalLine + 1, entry.originalColumn + 1, 'react-source-map');
  } catch { return undefined; }
}

export function inlineMap(value: string): unknown {
  if (value.length > 2_800_000) return undefined;
  const match = /^data:application\/json(?:;charset=[\w-]+)?(;base64)?,([\s\S]+)$/.exec(value);
  if (!match) return undefined;
  try {
    const text = match[1] ? Buffer.from(match[2]!, 'base64').toString('utf8') : decodeURIComponent(match[2]!);
    return text.length <= 2_097_152 ? JSON.parse(text) : undefined;
  } catch { return undefined; }
}

