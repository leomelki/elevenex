import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  lstat,
  writeFile,
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
  stagedRevision,
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
    throw new ConflictException({
      code: 'commit-conflicts',
      message: 'Resolve conflicts before committing.',
    });
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
  let phase: 'writing' | 'committing' | undefined;
  let guardError: ConflictException | undefined;
  let ownsLock = false;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await writeFile(index, before);
    await writeFile(preserved, before);
    const beforeStaged = await stagedRevision(path, preserved);
    const snapshot = worktreeSimpleGit(path)
      .env('GIT_INDEX_FILE', index)
      .env('GIT_LITERAL_PATHSPECS', '1');
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
    if (selection.includeUnstaged) {
      for (let at = 0; at < included.length; at += 100) {
        const batch = included.slice(at, at + 100);
        const tracked = new Set(
          (
            await snapshot.raw(['ls-files', '--cached', '-z', '--', ...batch])
          ).split('\0'),
        );
        // Staged deletions and rename sources are already absent from this index.
        // Passing those absent pathspecs to add fails the entire commit.
        const candidates = await Promise.all(
          batch.map(async (file) => {
            if (tracked.has(file)) return file;
            try {
              await lstat(resolve(path, file));
              return file;
            } catch (error) {
              if (
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                error.code === 'ENOENT'
              )
                return null;
              throw error;
            }
          }),
        );
        const stage = candidates.filter(
          (file): file is string => file !== null,
        );
        if (stage.length) await snapshot.raw(['add', '--all', '--', ...stage]);
      }
    }
    await gitService.commit(path, {
      message,
      indexFile: index,
      onPhase: (value) => {
        phase = value;
        onPhase(value);
      },
      beforeCommit: async () => {
        try {
          lock = await open(`${indexPath}.lock`, 'wx');
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'EEXIST'
          )
            guardError = new ConflictException({
              code: 'commit-index-locked',
              message: 'Another Git operation is using the index.',
            });
          throw error;
        }
        ownsLock = true;
        if (
          (await stagedRevision(path)) !== beforeStaged ||
          (await checkout.raw(['rev-parse', 'HEAD'])).trim() !== head ||
          (await checkout.raw(['symbolic-ref', 'HEAD'])).trim() !== branch
        )
          throw (guardError = new ConflictException({
            code: 'commit-changes-moved',
            message:
              'Staged changes or the branch changed while writing the message. Review before committing again.',
          }));
      },
    });
    committed = true;
    // Only selected paths follow the new HEAD. Other staged changes survive verbatim.
    const keep = worktreeSimpleGit(path)
      .env('GIT_INDEX_FILE', preserved)
      .env('GIT_LITERAL_PATHSPECS', '1');
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
    if (guardError) throw guardError;
    // The legacy commit service wraps pre-publication exceptions. Preserve our
    // classified guards, and keep raw hook/provider output private to the backend.
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EEXIST'
    )
      throw new ConflictException({
        code: 'commit-index-locked',
        message: 'Another Git operation is using the index.',
      });
    if (error instanceof ConflictException) throw error;
    throw new ConflictException({
      code: phase === 'writing' ? 'commit-message-failed' : 'commit-rejected',
      message:
        phase === 'writing'
          ? 'Could not write a commit message. Enter one and try again.'
          : 'Git rejected the commit. Check hooks, signing and Git identity.',
    });
  } finally {
    if (lock) await lock.close();
    if (ownsLock) await rm(`${indexPath}.lock`, { force: true });
    await rm(folder, { recursive: true, force: true });
  }
}
