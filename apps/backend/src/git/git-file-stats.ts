import { createReadStream } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
import * as path from 'node:path';
import { GitByteLru, GitCacheBudget } from './git-cache.js';
import { readPathVersion } from './git-local-state.js';
import { gitHashScheduler, gitRepositoryKey } from './git-read-scheduler.js';

interface TextStats {
  lines: number | null;
  binary: boolean;
}
const MAX_BYTES = 1_000_000;
const cache = new GitByteLru<{ version: string; stats: TextStats }>(
  new GitCacheBudget(8 * 1024 * 1024),
);
const builds = new Map<string, Promise<TextStats>>();
const publications = new Map<string, object>();

/** Shared by status and net review only for untracked content, whose semantics match. */
export async function readWorktreeTextStats(
  worktreePath: string,
  filePath: string,
  knownVersion?: string,
  knownSize?: number,
): Promise<TextStats> {
  const absolute = path.join(worktreePath, filePath);
  const version = knownVersion ?? (await readPathVersion(absolute));
  const cached = cache.get(absolute);
  if (cached?.version === version) return cached.stats;
  const key = [absolute, version].join('\0');
  const active = builds.get(key);
  if (active) return active;
  const publication = {};
  publications.set(absolute, publication);
  const pending = gitHashScheduler
    .run(gitRepositoryKey(worktreePath), async () => {
      const before = await readPathVersion(absolute);
      const info = await lstat(absolute);
      if (knownVersion && knownVersion !== before)
        throw new Error(
          'File changed since the status scan; retry text statistics.',
        );
      const size = knownSize ?? info.size;
      let stats: TextStats = { lines: null, binary: false };
      if (size <= MAX_BYTES && info.size <= MAX_BYTES) {
        const chunks: Buffer[] = [];
        let bytes = 0;
        if (info.isSymbolicLink()) {
          chunks.push(Buffer.from(await readlink(absolute)));
        } else
          for await (const chunk of createReadStream(absolute, {
            end: MAX_BYTES,
          })) {
            bytes += (chunk as Buffer).length;
            if (bytes > MAX_BYTES)
              throw new Error(
                'File changed while reading text statistics; retry.',
              );
            chunks.push(chunk as Buffer);
          }
        const buffer = Buffer.concat(chunks);
        const binary = buffer.includes(0);
        let lines = buffer.length && buffer[buffer.length - 1] !== 10 ? 1 : 0;
        if (!binary) for (const byte of buffer) if (byte === 10) lines++;
        stats = { lines: binary ? 0 : lines, binary };
      }
      if ((await readPathVersion(absolute)) !== before)
        throw new Error('File changed while reading text statistics; retry.');
      if (publications.get(absolute) === publication) {
        cache.set(absolute, { version, stats });
        while (cache.size > 10_000)
          for (const oldest of cache.keys()) {
            cache.delete(oldest);
            break;
          }
      }
      return stats;
    })
    .finally(() => {
      if (builds.get(key) === pending) builds.delete(key);
      if (publications.get(absolute) === publication)
        publications.delete(absolute);
    });
  builds.set(key, pending);
  return pending;
}

export function clearWorktreeTextStats(worktreePath: string): void {
  const prefix = path.resolve(worktreePath) + path.sep;
  for (const map of [cache, builds, publications])
    for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key);
}
