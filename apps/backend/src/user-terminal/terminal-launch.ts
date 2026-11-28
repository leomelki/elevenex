import { BadRequestException } from '@nestjs/common';
import { basename, win32 } from 'node:path';

export interface TerminalLaunchOptions {
  readonly size?: { cols: number; rows: number };
  readonly protocol?: 1;
  readonly profile?: { executable: string; args: string[]; env: Record<string, string | null>; login: boolean };
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('Invalid terminal profile');
  return raw as Record<string, unknown>;
}
export function parseTerminalLaunch(input: Record<string, unknown>): TerminalLaunchOptions {
  let size: TerminalLaunchOptions['size'], profile: TerminalLaunchOptions['profile'];
  if (input.protocol !== undefined && input.protocol !== 1) throw new BadRequestException('Unsupported terminal protocol');
  if (input.size !== undefined) {
    const value = object(input.size);
    if (typeof value.cols !== 'number' || !Number.isInteger(value.cols) || value.cols < 2 || value.cols > 500 ||
        typeof value.rows !== 'number' || !Number.isInteger(value.rows) || value.rows < 1 || value.rows > 300 ||
        Object.keys(value).some(key => !['cols', 'rows'].includes(key))) throw new BadRequestException('Invalid terminal size');
    size = { cols: value.cols, rows: value.rows };
  }
  if (input.profile !== undefined) {
    const value = object(input.profile), env = object(value.env);
    if (Object.keys(value).some(key => !['executable', 'args', 'env', 'login'].includes(key)) ||
        typeof value.executable !== 'string' || !value.executable || value.executable.length > 8192 || value.executable.includes('\0') ||
        !Array.isArray(value.args) || value.args.length > 32 || value.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')) ||
        typeof value.login !== 'boolean' || Object.keys(env).length > 64 ||
        Object.entries(env).some(([key, entry]) => !/^[A-Za-z_][A-Za-z\d_]*$/.test(key) || key.length > 128 ||
          key.startsWith('ELEVENEX_') || (entry !== null && (typeof entry !== 'string' || entry.length > 8192 || entry.includes('\0')))) ||
        JSON.stringify(value).length > 32768) throw new BadRequestException('Invalid terminal profile');
    const environment: Record<string, string | null> = {};
    for (const [key, entry] of Object.entries(env)) {
      if (typeof entry !== 'string' && entry !== null) throw new BadRequestException('Invalid terminal environment');
      Object.defineProperty(environment, key, { value: entry, enumerable: true });
    }
    const args: string[] = [];
    for (const arg of value.args) { if (typeof arg !== 'string') throw new BadRequestException('Invalid terminal argument'); args.push(arg); }
    if (value.login && !['bash', 'zsh', 'sh', 'fish', 'ksh'].includes(win32.basename(basename(value.executable))))
      throw new BadRequestException('Login mode requires a POSIX shell supporting -l');
    profile = { executable: value.executable, args, env: environment, login: value.login };
  }
  return { ...(size ? { size } : {}), ...(profile ? { profile } : {}), ...(input.protocol === 1 ? { protocol: 1 } : {}) };
}
