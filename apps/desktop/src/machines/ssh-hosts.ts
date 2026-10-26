import { open } from 'node:fs/promises';
import type { SshHostSuggestion } from '@elevenex/shared';

/** Suggestions only: OpenSSH remains the authority for config, Includes and keys.
 * Never run ssh -G on keystrokes: Match exec may execute commands in user config.
 */
export async function sshHostSuggestions(path: string, query: string): Promise<readonly SshHostSuggestion[]> {
  let body: string;
  try {
    const file = await open(path, 'r');
    try {
      if ((await file.stat()).size > 1024 * 1024) throw new Error('SSH config exceeds the suggestion limit');
      body = await file.readFile('utf8');
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw new Error('SSH host suggestions are unavailable. Enter a host directly.', { cause: error });
  }
  const names = new Set<string>();
  const needle = query.trim().toLowerCase();
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*Host\s+(.+?)(?:\s+#.*)?$/i.exec(line);
    if (!match?.[1]) continue;
    for (const token of match[1].split(/\s+/)) {
      const name = token.replace(/^(['"])(.*)\1$/, '$2');
      if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/.test(name) && name.toLowerCase().includes(needle)) names.add(name);
      if (names.size === 8) return [...names].map(host => ({ host }));
    }
  }
  return [...names].map(host => ({ host }));
}
