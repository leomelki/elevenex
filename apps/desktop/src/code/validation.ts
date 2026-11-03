import type { CodeBounds, CodeOpenFile, CodeTarget } from '@elevenex/shared';
import { invalidResponse } from '../backend-client/transport';
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}
export function string(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw invalidResponse();
  return value;
}
export function number(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw invalidResponse(); return value;
}
export function target(value: unknown): CodeTarget {
  const raw = object(value);
  if (Object.keys(raw).some(k => k !== 'scopeId' && k !== 'taskId') || typeof raw['scopeId'] !== 'string' || !/^[a-f0-9-]{36}$/.test(raw['scopeId']) || typeof raw['taskId'] !== 'number' || !Number.isSafeInteger(raw['taskId']) || raw['taskId'] < 1) throw new Error('Invalid Code target');
  return { scopeId: raw['scopeId'], taskId: raw['taskId'] };
}
export function bounds(value: unknown): CodeBounds | null {
  if (value === null) return null;
  const raw = object(value);
  if (Object.keys(raw).sort().join(',') !== 'height,width,x,y') throw new Error('Invalid editor bounds');
  return { x: number(raw['x'], 20_000), y: number(raw['y'], 20_000), width: number(raw['width'], 20_000), height: number(raw['height'], 20_000) };
}
export function file(value: unknown): CodeOpenFile {
  const raw = object(value), path = string(raw['path']);
  if (Object.keys(raw).some(k => !['path', 'line', 'column'].includes(k)) || !path || path.startsWith('/') || path.split('/').some(p => p === '..' || p === '.' || p.toLowerCase() === '.git') || /(?:^|[\\/])\.\.?(?:[\\/]|$)/.test(path)) throw new Error('Invalid task file');
  const result: CodeOpenFile = { path, ...(raw['line'] === undefined ? {} : { line: number(raw['line'], 10_000_000) }), ...(raw['column'] === undefined ? {} : { column: number(raw['column'], 10_000_000) }) };
  if (result.line !== undefined && (!Number.isInteger(result.line) || result.line < 1) || result.column !== undefined && (!Number.isInteger(result.column) || result.column < 1)) throw new Error('Invalid file position');
  return result;
}
export interface WorkspaceDescriptor { readonly version: 1; readonly taskId: number; readonly identity: string; readonly storageIdentity: string; readonly name: string; readonly branch: string }
export function descriptor(value: unknown, taskId: number): WorkspaceDescriptor {
  const raw = object(value), identity = string(raw['identity'], 64);
  if (raw['version'] !== 1 || raw['taskId'] !== taskId || !/^[a-f0-9]{64}$/.test(identity)) throw invalidResponse();
  const storageIdentity = raw['storageIdentity'] === undefined ? identity : revision(raw['storageIdentity']);
  return { version: 1, taskId, identity, storageIdentity, name: string(raw['name'], 256), branch: string(raw['branch'], 256) };
}
const list = (value: unknown, max: number): unknown[] => { if (!Array.isArray(value) || value.length > max) throw invalidResponse(); return value; };
const bool = (value: unknown): boolean => { if (typeof value !== 'boolean') throw invalidResponse(); return value; };
const revision = (value: unknown) => { const text = string(value, 64); if (!/^[a-f0-9]{64}$/.test(text)) throw invalidResponse(); return text; };
export const CODE_OPERATIONS = ['stat', 'read', 'directory', 'write', 'mkdir', 'rename', 'delete', 'filenames', 'search', 'search-page', 'search-cancel', 'changes'] as const;
export type CodeOperation = typeof CODE_OPERATIONS[number];
/** Forward only each named operation's bounded serializable public projection. */
export function reply(operation: CodeOperation, value: unknown): unknown {
  const raw = object(value);
  switch (operation) {
    case 'stat': { const type = number(raw['type'], 2); if (type !== 1 && type !== 2) throw invalidResponse(); const permissions = raw['permissions']; if (permissions !== undefined && permissions !== 1) throw invalidResponse(); return { type, size: number(raw['size']), ctime: number(raw['ctime']), mtime: number(raw['mtime']), ...(permissions === 1 ? { permissions: 1 } : {}) }; }
    case 'read': { const content = string(raw['content'], 12 * 1024 * 1024); if (content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw invalidResponse(); return { content, revision: revision(raw['revision']) }; }
    case 'write': return { revision: revision(raw['revision']) };
    case 'directory': return { entries: list(raw['entries'], 200).map(v => { const e = object(v), name = string(e['name'], 4096); if (!name || name.includes('/') || name === '..' || name === '.') throw invalidResponse(); const type = number(e['type'], 2); if (type !== 1 && type !== 2) throw invalidResponse(); return { name, type }; }), next: raw['next'] === null ? null : string(raw['next']) };
    case 'filenames': return { paths: list(raw['paths'], 200).map(v => string(v)), limited: bool(raw['limited']) };
    case 'search': case 'search-page': return { id: string(raw['id'], 36), done: bool(raw['done']), limited: bool(raw['limited']), ...(raw['error'] === undefined ? {} : { error: string(raw['error'], 1000) }), rows: list(raw['rows'], 100).map(v => { const r = object(v); return { path: string(r['path']), line: number(r['line']), start: number(r['start']), end: number(r['end']), text: string(r['text'], 2048) }; }) };
    case 'changes': return { ...(raw['taskName'] === undefined ? {} : { taskName: string(raw['taskName'], 256) }), ...(raw['branch'] === undefined ? {} : { branch: string(raw['branch'], 256) }), sequence: number(raw['sequence']), reset: bool(raw['reset']), paths: list(raw['paths'], 128).map(v => string(v)) };
    default: if (raw['accepted'] !== true) throw invalidResponse(); return { accepted: true };
  }
}
