import type { TaskTerminalProfile, TaskTerminalPreferences } from '@elevenex/shared';
import { object, text, keys } from './terminal-validation';

export function terminalProfile(raw: unknown): TaskTerminalProfile {
  const value = object(raw); keys(value, ['executable', 'args', 'env', 'login']);
  const executable = text(value['executable'], 8192), args = value['args'], env = object(value['env']);
  if (!executable || executable.includes('\0') || !Array.isArray(args) || args.length > 32 || typeof value['login'] !== 'boolean' ||
      Object.keys(env).length > 64 || JSON.stringify(value).length > 32768) throw new Error('Invalid terminal profile');
  const parsedArgs = args.map((raw: unknown) => {
    const arg = text(raw, 4096); if (arg.includes('\0')) throw new Error('Invalid terminal argument'); return arg;
  });
  const entries = Object.entries(env).map(([key, raw]): [string, string | null] => {
    if (!/^[A-Za-z_][A-Za-z\d_]*$/.test(key) || key.length > 128 || key.startsWith('ELEVENEX_')) throw new Error('Invalid terminal environment');
    const entry = raw === null ? null : text(raw, 8192);
    if (entry?.includes('\0')) throw new Error('Invalid terminal environment');
    return [key, entry];
  });
  return { executable, args: parsedArgs, env: Object.fromEntries(entries), login: value['login'] };
}
export function terminalPreferences(raw: unknown): TaskTerminalPreferences {
  const value = object(raw); keys(value, ['profile', 'prediction']);
  if (value['prediction'] !== 'auto' && value['prediction'] !== 'off') throw new Error('Invalid terminal prediction setting');
  return { prediction: value['prediction'], profile: value['profile'] === null ? null : terminalProfile(value['profile']) };
}
