import { ConflictException } from '@nestjs/common';
import { worktreeSimpleGit } from '../config/system-paths.js';
import { readWorktreeTextStats } from '../git/git-file-stats.js';
import type { GitStatusSummary } from '../git/git.service.js';
import {
  commitRevision,
  mayHoldSecrets,
  selectedPaths,
  type CommitSelection,
} from './desktop-commit-selection.js';

function numstat(raw: string): Map<string, { add: number; del: number }> {
  const result = new Map<string, { add: number; del: number }>();
  for (const row of raw.split('\0')) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row);
    if (match)
      result.set(match[3], {
        add: Number(match[1]) || 0,
        del: Number(match[2]) || 0,
      });
  }
  return result;
}
async function loadCommitFiles(
  path: string,
  status: GitStatusSummary,
  includeUnstaged: boolean,
) {
  const git = worktreeSimpleGit(path, { readOnly: true });
  const [allStats, stagedStats] = await Promise.all([
    git.raw(['diff', 'HEAD', '--numstat', '-z', '--no-renames', '--']),
    git.raw(['diff', '--cached', '--numstat', '-z', '--no-renames', '--']),
  ]);
  const all = numstat(allStats),
    staged = numstat(stagedStats);
  const paths = [...new Set(status.files.map((file) => file.path))];
  const untracked = new Set(
    status.files
      .filter((file) => file.status === 'untracked')
      .map((file) => file.path),
  );
  // The shared reader bounds file bytes and schedules concurrent hashing across repositories.
  for (let at = 0; at < paths.length; at += 16)
    await Promise.all(
      paths.slice(at, at + 16).map(async (file) => {
        if (untracked.has(file))
          all.set(file, {
            add: (await readWorktreeTextStats(path, file)).lines ?? 0,
            del: 0,
          });
      }),
    );
  const grouped = new Map<string, typeof status.files>();
  for (const file of status.files) {
    const rows = grouped.get(file.path);
    if (rows) rows.push(file);
    else grouped.set(file.path, [file]);
  }
  return paths.map((path) => {
    const rows = grouped.get(path)!,
      file = rows[0];
    const isStaged = rows.some((file) => file.staged);
    const stats = (includeUnstaged ? all : staged).get(path) ?? {
      add: 0,
      del: 0,
    };
    return {
      path,
      status: (
        {
          modified: 'M',
          added: 'A',
          deleted: 'D',
          renamed: 'R',
          untracked: 'A',
          conflicted: 'U',
        } as const
      )[file.status],
      add:
        stats.add +
        (file.oldPath
          ? ((includeUnstaged ? all : staged).get(file.oldPath)?.add ?? 0)
          : 0),
      del:
        stats.del +
        (file.oldPath
          ? ((includeUnstaged ? all : staged).get(file.oldPath)?.del ?? 0)
          : 0),
      staged: isStaged,
      ...(mayHoldSecrets(path) ? { flag: 'secrets' as const } : {}),
    };
  });
}

/** A small owner-scoped metadata cache lets filters/pages reuse the same Git snapshot. */
export class CommitPreviewReader {
  private generation = 0;
  private readonly cache = new Map<
    string,
    { files: Awaited<ReturnType<typeof loadCommitFiles>>; bytes: number }
  >();
  private readonly pending = new Map<
    string,
    ReturnType<typeof loadCommitFiles>
  >();
  clear(): void {
    this.generation++;
    this.cache.clear();
    this.pending.clear();
  }
  async files(
    path: string,
    status: GitStatusSummary,
    includeUnstaged: boolean,
    revision: string,
  ) {
    const generation = this.generation;
    const key = JSON.stringify([path, revision, status.worktreeFingerprint, includeUnstaged]);
    const cached = this.cache.get(key);
    if (cached) return cached.files;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = loadCommitFiles(path, status, includeUnstaged);
    this.pending.set(key, promise);
    try {
      const files = await promise;
      const bytes = files.reduce(
        (total, file) => total + file.path.length * 2 + 128,
        0,
      );
      if (generation === this.generation && bytes <= 4 * 1024 * 1024) {
        while (
          this.cache.size &&
          ([...this.cache.values()].reduce((n, entry) => n + entry.bytes, 0) +
            bytes >
            4 * 1024 * 1024 ||
            this.cache.size >= 4)
        )
          this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { files, bytes });
      }
      return files;
    } finally {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    }
  }
}

/** One bounded reply; filtering and ranking happen before slicing, never in the renderer. */
export async function previewCommit(
  path: string,
  status: GitStatusSummary,
  selection: CommitSelection,
  query: string,
  cursor: number,
  reader?: CommitPreviewReader,
) {
  const revision = await commitRevision(path, status);
  const files = reader
    ? await reader.files(path, status, selection.includeUnstaged, revision)
    : await loadCommitFiles(path, status, selection.includeUnstaged);
  if ((await commitRevision(path, status)) !== revision)
    throw new ConflictException('Staged changes moved on. Refresh the files.');
  const chosen = new Set(selectedPaths(status, selection));
  const selected = files.filter((file) => chosen.has(file.path));
  const matched = files
    .filter((file) => file.path.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => {
      const canA = selection.includeUnstaged || a.staged,
        canB = selection.includeUnstaged || b.staged;
      return (
        Number(canB) - Number(canA) ||
        Number(!!b.flag) - Number(!!a.flag) ||
        b.add + b.del - (a.add + a.del) ||
        a.path.localeCompare(b.path)
      );
    });
  return {
    revision,
    items: matched.slice(cursor, cursor + 100),
    nextCursor: cursor + 100 < matched.length ? String(cursor + 100) : null,
    matches: matched.length,
    total: files.length,
    unstaged: status.unstaged.files,
    selected: {
      files: selected.length,
      add: selected.reduce((n, file) => n + file.add, 0),
      del: selected.reduce((n, file) => n + file.del, 0),
      staged: selected.filter((file) => file.staged).length,
      unstaged: selected.filter((file) => !file.staged).length,
    },
  };
}
