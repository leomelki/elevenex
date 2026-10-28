import { BadRequestException } from '@nestjs/common';
import { constants } from 'node:fs';
import { open, opendir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { cloneRepositoryName } from './desktop-project-repositories.js';

/** One directory level, with bounded traversal and request-owned cancellation. */
export async function listWorkspaceFolders(
  query: string,
  limit: number,
  signal: AbortSignal,
) {
  if (
    typeof query !== 'string' ||
    query.length > 4096 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new BadRequestException('Invalid folder query.');
  signal.throwIfAborted();
  const trimmed = query.trim();
  if (/^(https?:|ssh:|git@)/i.test(trimmed)) {
    const name = cloneRepositoryName(trimmed);
    if (!name) throw new BadRequestException('Enter an HTTPS or SSH Git URL.');
    return [
      {
        path: join(homedir(), 'code', name),
        name,
        git: null,
        dir: false,
        clone: trimmed,
      },
    ];
  }
  const expanded =
    query === '~' || query.startsWith('~/')
      ? homedir() + query.slice(1)
      : query || homedir() + '/';
  if (!isAbsolute(expanded))
    throw new BadRequestException('An absolute path is required.');
  const exact = await stat(expanded).catch(() => null);
  signal.throwIfAborted();
  const browsing = query.endsWith('/') || query === '';
  const root = browsing ? expanded : dirname(expanded),
    prefix = browsing ? '' : basename(expanded).toLowerCase();
  const results: {
    path: string;
    name: string;
    git: string | null;
    dir: boolean;
    clone?: string;
  }[] = [];
  if (exact?.isDirectory() && !browsing) {
    const path = resolve(expanded);
    return [
      {
        path,
        name: basename(path) || path,
        git: await repositoryLabel(path),
        dir: true,
      },
    ];
  }
  const directory = await opendir(root).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw new BadRequestException(
      'The folder could not be opened. Check its permissions.',
    );
  });
  if (!directory) return results;
  let inspected = 0;
  for await (const entry of directory) {
    signal.throwIfAborted();
    if (++inspected > 2000 || results.length >= limit) break;
    if (
      !entry.isDirectory() ||
      entry.name.startsWith('.') ||
      !entry.name.toLowerCase().startsWith(prefix)
    )
      continue;
    const path = join(root, entry.name);
    const git = await repositoryLabel(path);
    results.push({ path, name: entry.name, git, dir: true });
  }
  signal.throwIfAborted();
  return results.slice(0, limit);
}

/** Read only bounded Git metadata; never count commits or enumerate branches. */
async function repositoryLabel(path: string): Promise<string | null> {
  const marker = join(path, '.git');
  const info = await stat(marker).catch(() => null);
  if (!info) return null;
  if (!info.isDirectory() && !info.isFile()) return 'Git repository';
  const gitDirectory = info.isDirectory()
    ? marker
    : resolve(
        path,
        (await readMetadata(marker)).replace(/^gitdir: /, '').trim(),
      );
  const head = (await readMetadata(join(gitDirectory, 'HEAD'))).trim();
  if (head.startsWith('ref: refs/heads/'))
    return head.slice('ref: refs/heads/'.length, 256);
  return /^[a-f0-9]{40,64}$/.test(head)
    ? 'detached · ' + head.slice(0, 7)
    : 'Git repository';
}
async function readMetadata(path: string): Promise<string> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK,
  ).catch(() => null);
  if (!file) return '';
  try {
    if (!(await file.stat()).isFile()) return '';
    const { buffer, bytesRead } = await file.read(Buffer.alloc(512), 0, 512, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await file.close();
  }
}
