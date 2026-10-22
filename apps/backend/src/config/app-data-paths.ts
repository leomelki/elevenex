import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** A launcher can isolate app-owned data without changing the user's home/tools. */
export function getElevenexDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ELEVENEX_DATA_ROOT?.trim();
  if (!configured) return join(homedir(), '.elevenex');
  if (!isAbsolute(configured)) throw new Error('ELEVENEX_DATA_ROOT must be an absolute directory');
  return configured;
}
