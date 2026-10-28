import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  copyFile,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { worktreeSimpleGit } from '../config/system-paths.js';
import type { GitService, GitStatusSummary } from '../git/git.service.js';
import {
  selectedPaths,
  type CommitSelection,
} from './desktop-commit-selection.js';

/** Freeze the chosen index before message generation. A short index lock protects publication,
 * while excluded staged entries and working files retain their original contents. */
export async function commitSnapshot(
  path: string,
  gitService: GitService,
  status: GitStatusSummary,
  selection: CommitSelection,
  message: string,
  onPhase: (phase: 'writing' | 'committing') => void,
) {
  const paths = selectedPaths(status, selection);
  if (!paths.length)
    throw new BadRequestException('Choose at least one changed file.');
  if (status.files.some((file) => file.status === 'conflicted'))
    throw new ConflictException('Resolve conflicts before committing.');
  const checkout = worktreeSimpleGit(path);
  const indexPath = resolve(
    path,
    (await checkout.raw(['rev-parse', '--git-path', 'index'])).trim(),
  );
  const before = await readFile(indexPath);
  const head = (await checkout.raw(['rev-parse', 'HEAD'])).trim();
  const branch = (await checkout.raw(['symbolic-ref', 'HEAD'])).trim();
  const folder = await mkdtemp(join(tmpdir(), 'elevenex-commit-'));
  const index = join(folder, 'index'),
    preserved = join(folder, 'preserved-index');
  let committed = false;
  let ownsLock = false;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await copyFile(indexPath, index);
    await copyFile(indexPath, preserved);
    const snapshot = worktreeSimpleGit(path).env({
      ...process.env,
      GIT_INDEX_FILE: index,
      GIT_LITERAL_PATHSPECS: '1',
    });
    const selectedSet = new Set(paths);
    const excluded = status.files
      .filter((file) => !selectedSet.has(file.path))
      .flatMap((file) => [file.path, ...(file.oldPath ? [file.oldPath] : [])]);
    const included = status.files
      .filter((file) => selectedSet.has(file.path))
      .flatMap((file) => [file.path, ...(file.oldPath ? [file.oldPath] : [])]);
    for (let at = 0; at < excluded.length; at += 100)
      await snapshot.raw([
        'reset',
        '--quiet',
        head,
        '--',
        ...excluded.slice(at, at + 100),
      ]);
    if (selection.includeUnstaged)
      for (let at = 0; at < included.length; at += 100)
        await snapshot.raw([
          'add',
          '--all',
          '--',
          ...included.slice(at, at + 100),
        ]);
    await gitService.commit(path, {
      message,
      indexFile: index,
      onPhase,
      beforeCommit: async () => {
        lock = await open(`${indexPath}.lock`, 'wx');
        ownsLock = true;
        if (
          !(await readFile(indexPath)).equals(before) ||
          (await checkout.raw(['rev-parse', 'HEAD'])).trim() !== head ||
          (await checkout.raw(['symbolic-ref', 'HEAD'])).trim() !== branch
        )
          throw new ConflictException(
            'Staged changes or the branch changed while writing the message. Review before committing again.',
          );
      },
    });
    committed = true;
    // Only selected paths follow the new HEAD. Other staged changes survive verbatim.
    const keep = worktreeSimpleGit(path).env({
      ...process.env,
      GIT_INDEX_FILE: preserved,
      GIT_LITERAL_PATHSPECS: '1',
    });
    for (let at = 0; at < included.length; at += 100)
      await keep.raw([
        'reset',
        '--quiet',
        'HEAD',
        '--',
        ...included.slice(at, at + 100),
      ]);
    await lock!.writeFile(await readFile(preserved));
    await lock!.close();
    lock = undefined;
    await rename(`${indexPath}.lock`, indexPath);
    ownsLock = false;
  } catch (error) {
    if (
      committed ||
      (await checkout.raw(['rev-parse', 'HEAD'])).trim() !== head
    )
      throw new InternalServerErrorException(
        'The commit was saved but index reconciliation failed. Refresh status before continuing.',
      );
    throw error;
  } finally {
    if (lock) await lock.close();
    if (ownsLock) await rm(`${indexPath}.lock`, { force: true });
    await rm(folder, { recursive: true, force: true });
  }
}
