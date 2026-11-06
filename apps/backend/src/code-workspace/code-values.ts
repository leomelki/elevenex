import { BadRequestException } from '@nestjs/common';
export function codeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Invalid editor request.');
  return value as Record<string, unknown>;
}
export function codeText(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new BadRequestException('Invalid editor text.');
  return value;
}
export function codePath(value: unknown): string {
  const path = codeText(value);
  if (!path.startsWith('/') || path.startsWith('//') || process.platform === 'win32' && path.includes('\\') || path.slice(1).split('/').some(p => p === '.' || p === '..' || p.toLowerCase() === '.git')) throw new BadRequestException('Path is outside this task.');
  if (process.platform === 'win32' && path.slice(1).split('/').some(part => /[:<>"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new BadRequestException('Unsupported Windows file name.');
  if (/(?:^|[\\/])\.\.?(?:[\\/]|$)/.test(path)) throw new BadRequestException('Path is outside this task.');
  return path;
}
export function codeLimit(value: unknown, max = 200): number {
  if (value === undefined) return max;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw new BadRequestException('Invalid result limit.');
  return value;
}
export function codeRevision(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
import { createHash } from 'node:crypto';
