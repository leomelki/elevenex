import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SimpleGit } from 'simple-git';
import { worktreeSimpleGit } from '../config/system-paths.js';
import type { GitDiffRecord } from './git-diff-records.js';
import { readRepositoryIdentity } from './git-local-state.js';
import {
  gitFileScheduler,
  gitRepositoryKey,
  scheduledGitRaw,
  scheduledReadGit,
} from './git-read-scheduler.js';

/** Deleted/renamed comparison sources can reappear as untracked worktree files. */
export function restoredComparisonSources(
  records: readonly GitDiffRecord[],
  untracked: ReadonlySet<string>,
): GitDiffRecord[] {
  const sources = new Map<string, GitDiffRecord>();
  for (const record of records) {
    const source = record.status === 'deleted' ? record.path : record.oldPath;
    if (source && untracked.has(source))
      sources.set(source, {
        ...record,
        path: source,
        oldPath: null,
        status: 'deleted',
      });
  }
  return [...sources.values()];
}

/** A private index lets Git compare restored sources to their final worktree content. */
export async function withReviewIndex<T>(
  git: SimpleGit,
  worktreePath: string,
  sources: readonly GitDiffRecord[],
  read: (git: SimpleGit) => Promise<T>,
  priority = 0,
): Promise<T> {
  if (!sources.length) return read(git);
  const identity = await readRepositoryIdentity(git, worktreePath);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'elevenex-review-index-'),
  );
  const index = path.join(directory, 'index');
  try {
    await gitFileScheduler.run(gitRepositoryKey(worktreePath), () =>
      copyFile(path.join(identity.gitDir, 'index'), index),
    );
    const overrides = { GIT_INDEX_FILE: index };
    const input = sources
      .map((source) => `${source.oldMode} ${source.oldOid}\t${source.path}\0`)
      .join('');
    await scheduledGitRaw(
      worktreePath,
      [
        'update-index',
        '--add',
        '--replace',
        '--no-split-index',
        '-z',
        '--index-info',
      ],
      priority,
      overrides,
      input,
    );
    return await read(
      scheduledReadGit(
        worktreeSimpleGit(worktreePath, { readOnly: true }),
        worktreePath,
        priority,
        overrides,
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
