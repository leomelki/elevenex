import { createHash } from 'node:crypto';
import { lstat as stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { SimpleGit, StatusResult } from 'simple-git';

import { worktreeSimpleGit } from '../config/system-paths.js';
import {
  gitReadScheduler,
  gitFileScheduler,
  gitRepositoryKey,
} from './git-read-scheduler.js';
import { readGitDirectoryHead } from './git-local-state.js';
import { GitCacheBudget, retainedBytes } from './git-cache.js';

const STAT_CONCURRENCY = 32;
const WORKTREE_STATUS_CACHE_TTL_MS = 1_500;
const MAX_STATUS_CACHE_ENTRIES = 1_000;

export interface WorktreeStatusFingerprintSnapshot {
  status: StatusResult;
  fingerprint: string;
  statSignature: string;
  createdAt: number;
  /** Start of the authoritative Git scan; validation never extends it. */
  scannedAt: number;
  pathSizes: ReadonlyMap<string, number | null>;
  pathVersions: ReadonlyMap<string, string>;
}

interface StatusCacheEntry {
  snapshot?: WorktreeStatusFingerprintSnapshot;
  inFlight?: Promise<WorktreeStatusFingerprintSnapshot>;
  publication?: object;
  validation?: Promise<WorktreeStatusFingerprintSnapshot>;
}

// Entry identity is the generation: invalidation discards it without retaining
// version counters for worktrees that are no longer used.
const statusSnapshotCache = new Map<string, StatusCacheEntry>();
const statusScanTimes = new WeakMap<StatusResult, number>();
const snapshotBudget = new GitCacheBudget(16 * 1024 * 1024);

function publishSnapshot(
  key: string,
  entry: StatusCacheEntry,
  snapshot: WorktreeStatusFingerprintSnapshot,
): void {
  entry.snapshot = snapshot;
  snapshotBudget.add(entry, retainedBytes(snapshot), () => {
    entry.snapshot = undefined;
    snapshotBudget.remove(entry);
    releaseStatusCacheEntry(key, entry);
  });
}

export async function readWorktreeFingerprint(
  worktreePath: string,
  git: SimpleGit = worktreeSimpleGit(worktreePath, { readOnly: true }),
  status?: StatusResult,
): Promise<string> {
  if (status) {
    const key = path.resolve(worktreePath);
    const entry = getStatusCacheEntry(key);
    // Reusing status may revalidate its paths, but never gives it a new scan deadline.
    const scannedAt = statusScanTimes.get(status) ?? Date.now();
    statusScanTimes.set(status, scannedAt);
    // Supplied status supersedes a scan that started before it. Its callers
    // may finish, but new readers must not join that older scan.
    entry.inFlight = undefined;
    entry.validation = undefined;
    const publication = (entry.publication = {});
    try {
      const { fingerprint, statSignature, pathSizes, pathVersions } =
        await buildStatusWorktreeFingerprint(worktreePath, status);
      if (
        statusSnapshotCache.get(key) === entry &&
        entry.publication === publication
      ) {
        publishSnapshot(key, entry, {
          status,
          fingerprint,
          statSignature,
          createdAt: Date.now(),
          scannedAt,
          pathSizes,
          pathVersions,
        });
      }
      return fingerprint;
    } finally {
      if (entry.publication === publication) entry.publication = undefined;
      releaseStatusCacheEntry(key, entry);
    }
  }

  try {
    return (await readWorktreeStatusSnapshot(worktreePath, git)).fingerprint;
  } catch {
    return readRawWorktreeFingerprint(worktreePath, git);
  }
}

export async function readWorktreeStatusSnapshot(
  worktreePath: string,
  git: SimpleGit = worktreeSimpleGit(worktreePath, { readOnly: true }),
  options: { validateCached?: boolean } = {},
): Promise<WorktreeStatusFingerprintSnapshot> {
  const key = path.resolve(worktreePath);
  for (;;) {
    const cached = getCachedStatusSnapshot(key);
    if (!cached) break;
    if (!options.validateCached) return cached;

    const entry = getStatusCacheEntry(key);
    if (entry.validation) return entry.validation;
    const validate = async (): Promise<WorktreeStatusFingerprintSnapshot> => {
      const statSignature = await readStatusStatSignature(
        worktreePath,
        cached.status,
      );
      // A mutation or another reader may have replaced the snapshot while stat
      // was pending. Validate the replacement rather than returning/deleting it.
      if (getCachedStatusSnapshot(key) !== cached) {
        if (entry.validation === validation) entry.validation = undefined;
        return readWorktreeStatusSnapshot(worktreePath, git, options);
      }
      if (statSignature === cached.statSignature) return cached;
      statusSnapshotCache.get(key)!.snapshot = undefined;
      snapshotBudget.remove(entry);
      return readWorktreeStatusSnapshot(worktreePath, git);
    };
    const validation = validate().finally(() => {
      if (entry.validation === validation) entry.validation = undefined;
      releaseStatusCacheEntry(key, entry);
    });
    entry.validation = validation;
    return validation;
  }

  const entry = getStatusCacheEntry(key);
  if (entry.inFlight) return entry.inFlight;

  const publication = (entry.publication = {});
  const scannedAt = Date.now();
  const promise = (async () => {
    const status = await gitReadScheduler.run(
      gitRepositoryKey(worktreePath),
      () => git.status(['--no-ahead-behind']),
    );
    statusScanTimes.set(status, scannedAt);
    const { fingerprint, statSignature, pathSizes, pathVersions } =
      await buildStatusWorktreeFingerprint(worktreePath, status);
    const snapshot = {
      status,
      fingerprint,
      statSignature,
      createdAt: Date.now(),
      scannedAt,
      pathSizes,
      pathVersions,
    };
    if (
      statusSnapshotCache.get(key) === entry &&
      entry.publication === publication
    ) {
      publishSnapshot(key, entry, snapshot);
    }
    return snapshot;
  })().finally(() => {
    if (entry.inFlight === promise) entry.inFlight = undefined;
    if (entry.publication === publication) entry.publication = undefined;
    releaseStatusCacheEntry(key, entry);
  });
  entry.inFlight = promise;
  return promise;
}

export function clearWorktreeFingerprintCache(worktreePath?: string): void {
  if (!worktreePath) {
    for (const entry of statusSnapshotCache.values())
      snapshotBudget.remove(entry);
    statusSnapshotCache.clear();
    return;
  }
  const key = path.resolve(worktreePath);
  const entry = statusSnapshotCache.get(key);
  if (entry) snapshotBudget.remove(entry);
  statusSnapshotCache.delete(key);
}

async function readRawWorktreeFingerprint(
  worktreePath: string,
  git: SimpleGit,
): Promise<string> {
  const statusRaw = await git
    .raw(['status', '--porcelain=v2', '-z', '--untracked-files=normal'])
    .catch(() => '');
  const changedPaths = parsePorcelainV2Paths(statusRaw);
  const statRows = await mapWithConcurrency(
    [...changedPaths].sort(),
    STAT_CONCURRENCY,
    (filePath) => statFingerprint(worktreePath, filePath),
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

function getCachedStatusSnapshot(
  key: string,
): WorktreeStatusFingerprintSnapshot | null {
  const entry = statusSnapshotCache.get(key);
  const cached = entry?.snapshot;
  if (!cached) return null;
  if (Date.now() - cached.scannedAt >= WORKTREE_STATUS_CACHE_TTL_MS) {
    entry.snapshot = undefined;
    snapshotBudget.remove(entry);
    return null;
  }
  snapshotBudget.touch(entry);
  return cached;
}

function getStatusCacheEntry(key: string): StatusCacheEntry {
  let entry = statusSnapshotCache.get(key);
  if (!entry) {
    entry = {};
    statusSnapshotCache.set(key, entry);
  }
  return entry;
}

function releaseStatusCacheEntry(key: string, entry: StatusCacheEntry): void {
  if (
    !entry.snapshot &&
    !entry.inFlight &&
    !entry.validation &&
    !entry.publication &&
    statusSnapshotCache.get(key) === entry
  )
    statusSnapshotCache.delete(key);
  // Keep active work coalesced even when more than the retained-cache limit
  // is being read. Only completed, inactive entries may be evicted.
  for (const [cachedKey, cachedEntry] of statusSnapshotCache) {
    if (statusSnapshotCache.size <= MAX_STATUS_CACHE_ENTRIES) break;
    if (
      !cachedEntry.inFlight &&
      !cachedEntry.publication &&
      !cachedEntry.validation
    ) {
      statusSnapshotCache.delete(cachedKey);
      snapshotBudget.remove(cachedEntry);
    }
  }
}

export async function readStatusWorktreeFingerprint(
  worktreePath: string,
  status: StatusResult,
): Promise<string> {
  return (await buildStatusWorktreeFingerprint(worktreePath, status))
    .fingerprint;
}

async function buildStatusWorktreeFingerprint(
  worktreePath: string,
  status: StatusResult,
): Promise<{
  fingerprint: string;
  statSignature: string;
  pathSizes: ReadonlyMap<string, number | null>;
  pathVersions: ReadonlyMap<string, string>;
}> {
  const hash = createHash('sha256');
  for (const row of statusFingerprintRows(status)) {
    hash.update(row);
    hash.update('\n');
  }

  const statRows = await readStatusStatRows(worktreePath, status);
  for (const row of statRows) {
    hash.update(row);
    hash.update('\n');
  }

  return {
    fingerprint: hash.digest('hex'),
    statSignature: statRows.join('\n'),
    pathSizes: new Map(
      statRows.map((row) => {
        const [filePath, size] = row.split('\0', 2);
        return [filePath, size === 'missing' ? null : Number(size)];
      }),
    ),
    pathVersions: new Map(
      statRows.map((row) => {
        const [filePath, , version] = row.split('\0', 3);
        return [filePath, version ?? 'missing'];
      }),
    ),
  };
}

async function readStatusStatSignature(
  worktreePath: string,
  status: StatusResult,
): Promise<string> {
  return (await readStatusStatRows(worktreePath, status)).join('\n');
}

async function readStatusStatRows(
  worktreePath: string,
  status: StatusResult,
): Promise<string[]> {
  return mapWithConcurrency(
    [...statusFingerprintPaths(status)].sort(),
    STAT_CONCURRENCY,
    (filePath) => statFingerprint(worktreePath, filePath),
  );
}

function statusFingerprintRows(status: StatusResult): string[] {
  return [
    ...status.files.map((file) =>
      ['file', file.path, file.from ?? '', file.index, file.working_dir].join(
        '\0',
      ),
    ),
    ...status.renamed.map((file) => ['renamed', file.from, file.to].join('\0')),
    ...status.conflicted.map((filePath) => ['conflicted', filePath].join('\0')),
    ...status.staged.map((filePath) => ['staged', filePath].join('\0')),
    ...status.created.map((filePath) => ['created', filePath].join('\0')),
    ...status.modified.map((filePath) => ['modified', filePath].join('\0')),
    ...status.deleted.map((filePath) => ['deleted', filePath].join('\0')),
    ...status.not_added.map((filePath) => ['untracked', filePath].join('\0')),
  ].sort();
}

function statusFingerprintPaths(status: StatusResult): Set<string> {
  const paths = new Set<string>();
  for (const file of status.files) {
    paths.add(file.path);
  }
  for (const file of status.renamed) {
    paths.add(file.to);
  }
  for (const filePath of [
    ...status.not_added,
    ...status.created,
    ...status.modified,
    ...status.deleted,
    ...status.conflicted,
    ...status.staged,
  ]) {
    paths.add(filePath);
  }
  return paths;
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

async function statFingerprint(
  worktreePath: string,
  filePath: string,
): Promise<string> {
  return gitFileScheduler.run(gitRepositoryKey(worktreePath), async () => {
    const absolute = path.join(worktreePath, filePath);
    const fileStat = await stat(absolute, { bigint: true }).catch(() => null);
    if (fileStat?.isDirectory()) {
      const head = await readGitDirectoryHead(absolute);
      return head
        ? [filePath, 'missing', `gitlink:${head}`].join('\0')
        : `${filePath}\0missing`;
    }
    if (!fileStat || (!fileStat.isFile() && !fileStat.isSymbolicLink()))
      return `${filePath}\0missing`;
    const version = [
      fileStat.dev,
      fileStat.ino,
      fileStat.mode,
      fileStat.size,
      fileStat.mtimeNs,
      fileStat.ctimeNs,
    ].join(':');
    return [filePath, fileStat.size, version].join('\0');
  });
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, values.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await mapper(values[index]);
      }
    }),
  );

  return results;
}
