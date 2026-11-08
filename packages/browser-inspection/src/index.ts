import { SourceMap } from 'node:module';
import type { BrowserSourceLocation } from '@elevenex/shared';
import { browserSourceLocation, location, object } from './location';
import { sourceProbeExpression, sourceResourceExpression } from './probe';

export { browserSourceLocation } from './location';
export { sourceProbeExpression, sourceResourceExpression } from './probe';
/** Host supplies a fixed-expression runner in the page's main world, not a renderer bridge. */
export type PageEvaluation = (expression: string) => Promise<unknown>;

function sameOrigin(value: string, base: string): string | undefined {
  try {
    const url = new URL(value, base), page = new URL(base);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === page.origin && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

interface Frame { file: string; line: number; column: number }
function stackFrames(stack: string): Frame[] {
  const frames: Frame[] = [];
  for (const line of stack.slice(0, 8192).split('\n').slice(0, 30)) {
    const match = /(?:\(|\s)((?:https?:\/\/|webpack-internal:\/\/)[^\s()]+):(\d+):(\d+)\)?$/.exec(line);
    if (!match || /(?:node_modules|react-stack-|react-dom|jsx-dev-runtime)/.test(match[1]!) || /\bat (?:\S+\.)?(?:jsxDEV\w*|jsxProd\w*|react_stack_\w*)\b/.test(line)) continue;
    frames.push({ file: match[1]!, line: Number(match[2]), column: Number(match[3]) });
    if (frames.length === 8) break;
  }
  return frames;
}

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

function inlineMap(value: string): unknown {
  if (value.length > 2_800_000) return undefined;
  const match = /^data:application\/json(?:;charset=[\w-]+)?(;base64)?,([\s\S]+)$/.exec(value);
  if (!match) return undefined;
  try {
    const text = match[1] ? Buffer.from(match[2]!, 'base64').toString('utf8') : decodeURIComponent(match[2]!);
    return text.length <= 2_097_152 ? JSON.parse(text) : undefined;
  } catch { return undefined; }
}

/** One explicit human pick, at most two scripts + their maps; no persistent cache or listeners.
 * HMR query strings stay on resource requests. Abort/stale ownership belongs to the host;
 * the runner and each page fetch have deadlines, and current() stops follow-up work. */
export async function detectBrowserSource(evaluate: PageEvaluation, selector: string, pageUrl: string, current: () => boolean): Promise<BrowserSourceLocation | undefined> {
  if (!current() || !/^html(?: > (?:[a-z][a-z0-9-]{0,40}|\*):nth-child\([1-9][0-9]*\)){1,20}$/.test(selector)) return undefined;
  const deadline = Date.now() + 2000;
  let reads = 0;
  const resources = new Map<string, unknown>();
  const read = async (url: string): Promise<Record<string, unknown> | undefined> => {
    if (!current() || Date.now() > deadline) return undefined;
    if (!resources.has(url)) {
      if (++reads > 4) return undefined;
      const value = await evaluate(sourceResourceExpression(url));
      const raw = object(value);
      resources.set(url, raw && typeof raw['text'] === 'string' && raw['text'].length <= 2_097_152 && typeof raw['map'] === 'string' && raw['map'].length <= 2048 ? raw : undefined);
    }
    return current() ? object(resources.get(url)) : undefined;
  };
  try {
    const candidates: unknown = await evaluate(sourceProbeExpression(selector));
    if (!Array.isArray(candidates) || candidates.length > 6) return undefined;
    for (const candidate of candidates) {
      if (!current() || Date.now() > deadline) return undefined;
      const raw = object(candidate);
      if (!raw) continue;
      const direct = location(raw['file'], raw['line'], raw['column'], 'react-debug-source');
      if (direct) return direct;
      if (typeof raw['stack'] !== 'string') continue;
      for (const frame of stackFrames(raw['stack'])) {
        const scriptUrl = sameOrigin(frame.file, pageUrl);
        if (!scriptUrl) continue;
        const script = await read(scriptUrl);
        if (!script) continue;
        const text = String(script['text']);
        const directive = /(?:\/\/[#@]\s*sourceMappingURL=([^\s]+)|\/\*[#@]\s*sourceMappingURL=([^\s*]+)\s*\*\/)/g;
        let last: RegExpExecArray | null = null;
        for (let match = directive.exec(text); match; match = directive.exec(text)) last = match;
        const reference = String(script['map'] || last?.[1] || last?.[2] || '');
        let payload: unknown, mapBase = scriptUrl;
        if (reference.startsWith('data:')) payload = inlineMap(reference);
        else {
          const mapUrl = sameOrigin(reference, scriptUrl);
          if (!reference || !mapUrl) continue;
          mapBase = mapUrl;
          const map = await read(mapUrl);
          if (map) { try { payload = JSON.parse(String(map['text'])); } catch { continue; } }
        }
        const source = mappedSource(payload, frame.line, frame.column, mapBase);
        if (source && current()) return browserSourceLocation(source);
      }
    }
  } catch { /* Optional metadata must never break selector-only picking. */ }
  return undefined;
}
