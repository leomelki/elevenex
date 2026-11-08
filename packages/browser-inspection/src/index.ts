import type { BrowserSourceLocation, BrowserSourceResolution, BrowserComponentSource } from '@elevenex/shared';
import { browserComponentSource, location, object, sourceFile } from './location';
import { sourceProbeExpression } from './probe';
import { sourceResourceExpression } from './resource';
import { inlineMap, mappedSource } from './source-map';

export { browserComponentSource, browserSourceLocation } from './location';
export { sourceProbeExpression } from './probe';
export { sourceResourceExpression } from './resource';
export { mappedSource } from './source-map';
/** Host-owned runner; never exposed through the renderer bridge. */
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

/** One explicit human pick. Exact element metadata outranks ancestor locations and
 * component fallbacks. No cross-pick cache, application hooks or repository scanning. */
export async function detectBrowserSources(evaluate: PageEvaluation, selector: string, pageUrl: string, current: () => boolean): Promise<BrowserSourceResolution> {
  if (!current() || !/^html(?: > (?:[a-z][a-z0-9-]{0,40}|\*):nth-child\([1-9][0-9]*\)){1,20}$/.test(selector)) return {};
  const deadline = Date.now() + 2000;
  let reads = 0;
  const resources = new Map<string, unknown>();
  const read = async (url: string): Promise<Record<string, unknown> | undefined> => {
    if (!current() || Date.now() > deadline) return undefined;
    if (!resources.has(url)) {
      if (++reads > 4) return undefined;
      const value = await evaluate(sourceResourceExpression(url)).catch(() => undefined);
      const raw = object(value);
      resources.set(url, raw && typeof raw['text'] === 'string' && raw['text'].length <= 2_097_152 && typeof raw['map'] === 'string' && raw['map'].length <= 2048 ? raw : undefined);
    }
    return current() ? object(resources.get(url)) : undefined;
  };
  let componentSource: BrowserComponentSource | undefined;
  try {
    const candidates: unknown = await evaluate(sourceProbeExpression(selector));
    if (!Array.isArray(candidates) || candidates.length > 12) return {};
    for (const candidate of candidates) {
      if (!current()) return {};
      const raw = object(candidate);
      if (!raw || typeof raw['depth'] !== 'number' || !Number.isInteger(raw['depth']) || raw['depth'] < 0 || raw['depth'] > 7) continue;
      if (raw['type'] === 'component') {
        componentSource ??= browserComponentSource({ file: sourceFile(raw['file']), framework: raw['framework'], line: raw['line'], column: raw['column'] });
        continue;
      }
      const relation = raw['depth'] ? { relation: 'ancestor' as const } : {};
      if (raw['type'] === 'location') {
        const source = location(raw['file'], raw['line'], raw['column'], raw['kind']);
        if (source) return { source: { ...source, ...relation } };
      }
      if (raw['type'] !== 'stack' || typeof raw['stack'] !== 'string' || Date.now() > deadline) continue;
      for (const frame of stackFrames(raw['stack'])) {
        const scriptUrl = sameOrigin(frame.file, pageUrl);
        if (!scriptUrl) continue;
        const script = await read(scriptUrl);
        if (!script) continue;
        const directive = /(?:\/\/[#@]\s*sourceMappingURL=([^\s]+)|\/\*[#@]\s*sourceMappingURL=([^\s*]+)\s*\*\/)/g;
        let last: RegExpExecArray | null = null;
        const text = String(script['text']);
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
        if (source && current()) return { source: { ...source, ...relation } };
      }
    }
  } catch { /* Optional metadata must never break selector-only picking. */ }
  return current() && componentSource ? { componentSource } : {};
}

/** Preserve the original exact-location API for existing inspection consumers. */
export async function detectBrowserSource(evaluate: PageEvaluation, selector: string, pageUrl: string, current: () => boolean): Promise<BrowserSourceLocation | undefined> {
  return (await detectBrowserSources(evaluate, selector, pageUrl, current)).source;
}
