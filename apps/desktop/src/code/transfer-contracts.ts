import { object, string, number, reply } from './validation';

export const TRANSFER_CHUNK = 256 * 1024;
export const TRANSFER_MAX_FILE = 2 * 1024 * 1024 * 1024;
export type TransferOperation = 'transfer-stat' | 'transfer-read' | 'upload-begin' | 'upload-chunk' | 'upload-commit' | 'upload-abort' | 'directory' | 'mkdir';
export interface TransferStat { readonly exists: boolean; readonly type: number; readonly size: number; readonly revision: string | null }
export interface TransferDialogs {
  upload(folder: boolean): Promise<readonly string[]>;
  download(name: string): Promise<string | undefined>;
  downloadDirectory(): Promise<string | undefined>;
  replace(name: string): Promise<'replace' | 'skip' | 'replace-all' | 'skip-all' | 'cancel'>;
}
export function taskPath(value: unknown): string {
  const path = string(value);
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.slice(1).split('/').some(part => part === '.' || part === '..' || part.toLowerCase() === '.git' || part.startsWith('.elevenex-save-'))) throw new Error('File is outside this task.');
  return path;
}
/** A remote filename must also be safe on the receiving desktop's filesystem. */
export function transferName(value: unknown): string {
  const name = string(value, 255);
  const invalidWindowsName = process.platform === 'win32' && ([...name].some(character => character.charCodeAt(0) < 32) || /[:<>"|?*]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name));
  if (!name || /[\\/]/.test(name) || name === '.' || name === '..' || name.toLowerCase() === '.git' || name.startsWith('.elevenex-save-') || invalidWindowsName) throw new Error('This filename cannot be transferred to this computer.');
  return name;
}
export function transferStat(value: unknown): TransferStat {
  const raw = object(value);
  if (raw['exists'] === false) return { exists: false, type: 0, size: 0, revision: null };
  const revision = string(raw['revision'], 64), type = number(raw['type'], 2);
  if (raw['exists'] !== true || !/^[a-f0-9]{64}$/.test(revision) || type !== 1 && type !== 2) throw new Error('Invalid transfer metadata.');
  return { exists: true, type, size: number(raw['size']), revision };
}
export function transferReply(operation: TransferOperation, value: unknown): unknown {
  if (operation === 'transfer-stat') return transferStat(value);
  if (operation === 'directory') return reply('directory', value);
  const raw = object(value);
  if (operation === 'upload-begin') {
    const id = string(raw['id'], 36);
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid upload identity.');
    return { id };
  }
  if (operation === 'upload-chunk') return { offset: number(raw['offset'], TRANSFER_MAX_FILE) };
  if (operation === 'transfer-read') {
    const content = string(raw['content'], Math.ceil(TRANSFER_CHUNK / 3) * 4);
    if (content.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content) || Buffer.byteLength(content, 'base64') > TRANSFER_CHUNK) throw new Error('Invalid transfer bytes.');
    return { content, offset: number(raw['offset'], TRANSFER_MAX_FILE) };
  }
  if (raw['accepted'] !== true) throw new Error('Transfer was not accepted.');
  return { accepted: true };
}
