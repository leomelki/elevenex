import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { SimpleGit } from 'simple-git';

import { worktreeSimpleGit } from '../config/system-paths.js';

export async function readWorktreeFingerprint(
  worktreePath: string,
  git: SimpleGit = worktreeSimpleGit(worktreePath),
): Promise<string> {
  const statusRaw = await git
    .raw(['status', '--porcelain=v2', '-z', '--untracked-files=all'])
    .catch(() => '');
  const changedPaths = parsePorcelainV2Paths(statusRaw);
  const statRows = await Promise.all(
    [...changedPaths].sort().map((filePath) => statFingerprint(worktreePath, filePath)),
  );

  const hash = createHash('sha256');
  hash.update(statusRaw);
  hash.update('\n');
  for (const row of statRows) {
    hash.update(row);
    hash.update('\n');
  }
  return hash.digest('hex');
}

function parsePorcelainV2Paths(statusRaw: string): Set<string> {
  const paths = new Set<string>();
  const tokens = statusRaw.split('\0').filter(Boolean);
  for (const token of tokens) {
    const parsed = parsePorcelainV2Path(token);
    if (parsed) {
      paths.add(parsed);
    }
  }
  return paths;
}

function parsePorcelainV2Path(token: string): string | null {
  if (token.startsWith('? ') || token.startsWith('! ')) {
    return token.slice(2);
  }

  const ordinary = token.match(/^1 (?:\S+ ){7}(.+)$/);
  if (ordinary?.[1]) {
    return ordinary[1];
  }

  const renamed = token.match(/^2 (?:\S+ ){8}(.+)$/);
  if (renamed?.[1]) {
    return renamed[1];
  }

  const unmerged = token.match(/^u (?:\S+ ){9}(.+)$/);
  if (unmerged?.[1]) {
    return unmerged[1];
  }

  return null;
}

async function statFingerprint(worktreePath: string, filePath: string): Promise<string> {
  const fileStat = await stat(path.join(worktreePath, filePath)).catch(() => null);
  if (!fileStat?.isFile()) {
    return `${filePath}\0missing`;
  }
  return [
    filePath,
    fileStat.size,
    Math.floor(fileStat.mtimeMs),
    Math.floor(fileStat.ctimeMs),
    fileStat.mode,
  ].join('\0');
}
