import type { BrowserComponentSource, BrowserSourceLocation } from '@elevenex/shared';

export function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function position(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 10_000_000; }
function controls(value: string): boolean { return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127); }

/** Canonical source identifiers only. URL query/hash/credentials never enter chat.
 * This is display metadata, not filesystem path validation or a file-opening capability. */
export function sourceFile(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 || controls(value)) return undefined;
  let file = value.replaceAll('\\', '/');
  file = file.replace(/^webpack(?:-internal)?:\/\/[^/]*\//, '').replace(/^turbopack:\/\/\/\[project\]\//, '');
  if (/^(?:https?|file):\/\//.test(file)) {
    try { const url = new URL(file); if (url.username || url.password || url.search || url.hash) return undefined; file = url.pathname; } catch { return undefined; }
  }
  try { file = decodeURIComponent(file); } catch { return undefined; }
  if (controls(file) || /[?#]/.test(file)) return undefined;
  file = file.replace(/^\/@fs\//, '/').replace(/^(?:\(.*?\)\/)?\.\//, '').replace(/^\[project\]\//, '');
  if (file.length > 1024 || /(?:^|\/)node_modules(?:\/|$)/.test(file) || !/\.(?:[cm]?[jt]sx?|vue|svelte|html?)$/.test(file)) return undefined;
  if (/^[a-z][a-z\d+.-]*:/i.test(file) && !/^[a-z]:\//i.test(file)) return undefined;
  if (!file || file.includes('//') || file.split('/').some(part => part === '..' || part === '.')) return undefined;
  return file;
}

export function browserSourceLocation(value: unknown): BrowserSourceLocation | undefined {
  const raw = object(value);
  if (!raw || !sourceKind(raw['kind']) || (raw['relation'] !== undefined && raw['relation'] !== 'ancestor')) return undefined;
  const file = sourceFile(raw['file']);
  if (!file || file !== raw['file'] || !position(raw['line']) || (raw['column'] !== undefined && !position(raw['column']))) return undefined;
  return { file, line: raw['line'], ...(raw['column'] === undefined ? {} : { column: raw['column'] }), kind: raw['kind'], ...(raw['relation'] === 'ancestor' ? { relation: 'ancestor' } : {}) };
}

function sourceKind(value: unknown): value is BrowserSourceLocation['kind'] {
  return value === 'react-debug-source' || value === 'react-source-map' || value === 'angular-template' || value === 'svelte-metadata' || value === 'vue-inspector' || value === 'source-marker';
}

export function browserComponentSource(value: unknown): BrowserComponentSource | undefined {
  const raw = object(value);
  if (!raw || (raw['framework'] !== 'angular' && raw['framework'] !== 'vue')) return undefined;
  const file = sourceFile(raw['file']);
  if (!file || file !== raw['file'] || (raw['line'] !== undefined && !position(raw['line'])) || (raw['column'] !== undefined && (!position(raw['column']) || raw['line'] === undefined))) return undefined;
  return { file, framework: raw['framework'], ...(raw['line'] === undefined ? {} : { line: raw['line'] }), ...(raw['column'] === undefined ? {} : { column: raw['column'] }) };
}

export function location(file: unknown, line: unknown, column: unknown, kind: unknown): BrowserSourceLocation | undefined {
  const normalized = sourceFile(file);
  return normalized ? browserSourceLocation({ file: normalized, line, column, kind }) : undefined;
}
