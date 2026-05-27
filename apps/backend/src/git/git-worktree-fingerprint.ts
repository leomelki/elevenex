import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { SimpleGit, StatusResult } from 'simple-git';

import { worktreeSimpleGit } from '../config/system-paths.js';

const STAT_CONCURRENCY = 32;
const WORKTREE_STATUS_CACHE_TTL_MS = 1_500;

export interface WorktreeStatusFingerprintSnapshot {
  status: StatusResult;
  fingerprint: string;
  statSignature: string;
  createdAt: number;
}

const statusSnapshotCache = new Map<
  string,
  WorktreeStatusFingerprintSnapshot
>();
const statusSnapshotInFlight = new Map<
  string,
  Promise<WorktreeStatusFingerprintSnapshot>
>();
const statusSnapshotVersions = new Map<string, number>();
let globalStatusSnapshotVersion = 0;

export async function readWorktreeFingerprint(
  worktreePath: string,
  git: SimpleGit = worktreeSimpleGit(worktreePath),
  status?: StatusResult,
): Promise<string> {
  if (status) {
    const { fingerprint, statSignature } = await buildStatusWorktreeFingerprint(
      worktreePath,
      status,
    );
    cacheStatusSnapshot(worktreePath, status, fingerprint, statSignature);
    return fingerprint;
  }

  try {
    return (await readWorktreeStatusSnapshot(worktreePath, git)).fingerprint;
  } catch {
    return readRawWorktreeFingerprint(worktreePath, git);
  }
}

export async function readWorktreeStatusSnapshot(
  worktreePath: string,
  git: SimpleGit = worktreeSimpleGit(worktreePath),
  options: { validateCached?: boolean } = {},
): Promise<WorktreeStatusFingerprintSnapshot> {
  const cached = options.validateCached
    ? await getValidatedCachedStatusSnapshot(worktreePath)
    : getCachedStatusSnapshot(worktreePath);
  if (cached) return cached;

  const inFlight = statusSnapshotInFlight.get(worktreePath);
  if (inFlight) return inFlight;

  const cacheVersion = getSnapshotVersion(worktreePath);
  const promise = (async () => {
    const status = await git.status();
    const { fingerprint, statSignature } = await buildStatusWorktreeFingerprint(
      worktreePath,
      status,
    );
    if (getSnapshotVersion(worktreePath) !== cacheVersion) {
      return { status, fingerprint, statSignature, createdAt: Date.now() };
    }
    return cacheStatusSnapshot(
      worktreePath,
      status,
      fingerprint,
      statSignature,
    );
  })().finally(() => {
    statusSnapshotInFlight.delete(worktreePath);
  });
  statusSnapshotInFlight.set(worktreePath, promise);
  return promise;
}

export function clearWorktreeFingerprintCache(worktreePath?: string): void {
  if (!worktreePath) {
    statusSnapshotCache.clear();
    statusSnapshotInFlight.clear();
    statusSnapshotVersions.clear();
    globalStatusSnapshotVersion += 1;
    return;
  }
  statusSnapshotCache.delete(worktreePath);
  statusSnapshotInFlight.delete(worktreePath);
  statusSnapshotVersions.set(
    worktreePath,
    getSnapshotVersion(worktreePath) + 1,
  );
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
  worktreePath: string,
): WorktreeStatusFingerprintSnapshot | null {
  const cached = statusSnapshotCache.get(worktreePath);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > WORKTREE_STATUS_CACHE_TTL_MS) {
    statusSnapshotCache.delete(worktreePath);
    return null;
  }
  return cached;
}

async function getValidatedCachedStatusSnapshot(
  worktreePath: string,
): Promise<WorktreeStatusFingerprintSnapshot | null> {
  const cached = getCachedStatusSnapshot(worktreePath);
  if (!cached) return null;

  const statSignature = await readStatusStatSignature(
    worktreePath,
    cached.status,
  );
  if (statSignature !== cached.statSignature) {
    statusSnapshotCache.delete(worktreePath);
    return null;
  }

  return cached;
}

function cacheStatusSnapshot(
  worktreePath: string,
  status: StatusResult,
  fingerprint: string,
  statSignature: string,
): WorktreeStatusFingerprintSnapshot {
  const snapshot = {
    status,
    fingerprint,
    statSignature,
    createdAt: Date.now(),
  };
  statusSnapshotCache.set(worktreePath, snapshot);
  return snapshot;
}

function getSnapshotVersion(worktreePath: string): number {
  return (
    globalStatusSnapshotVersion +
    (statusSnapshotVersions.get(worktreePath) ?? 0)
  );
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
): Promise<{ fingerprint: string; statSignature: string }> {
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
  const fileStat = await stat(path.join(worktreePath, filePath)).catch(
    () => null,
  );
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

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
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
