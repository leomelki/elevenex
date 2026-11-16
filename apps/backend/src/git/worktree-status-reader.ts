/**
 * Fast `git status` for the backend's polled change views, with output
 * identical to simple-git's `status()`.
 *
 * Why
 * ---
 * `simple-git`'s `status()` runs `git status --porcelain -b -u --null`, and
 * `-u` means `--untracked-files=all`. Git's untracked cache only serves
 * `--untracked-files=normal`, so every poll walks the entire worktree. The
 * backend also exports `GIT_OPTIONAL_LOCKS=0` (see `main.ts`) so its reads never
 * take `.git/index.lock` away from an agent. As a side effect, Git can never
 * save the untracked cache or refreshed stat data, and every read starts cold.
 *
 * Measured with git 2.54 (cold → this reader, warm):
 *   dd-source (448k files)    6.2 s → 2.0 s
 *   logs-backend (49k files)  1.6 s → 0.46 s
 *   dd-go (44k files)         0.53 s → 0.16 s
 *
 * How
 * ---
 * 1. A private copy of the worktree's index lives in `<git-dir>/elevenex/`.
 *    Git replaces the index by renaming a new file over it, so a change of
 *    inode, size, or mtime catches every write; the copy is refreshed then.
 *    The copy keeps a whole-second mtime no newer than the real index, so
 *    Git's racy-entry detection stays at least as strict as on the original.
 * 2. Status runs against the copy (`GIT_INDEX_FILE`) with optional locks
 *    enabled and `core.untrackedCache=true`. Git saves the untracked cache and
 *    stat refreshes into the copy only; the real index and its lock are never
 *    touched, so agents can never hit an `index.lock` conflict.
 * 3. Status uses `--untracked-files=normal`, which collapses wholly untracked
 *    directories into `?? dir/`. Those entries are expanded with a
 *    pathspec-limited `git ls-files --others`, so callers get exactly the
 *    `--untracked-files=all` listing they always did.
 *
 * Fallback
 * --------
 * Whenever the fast path is unavailable or unproven, this runs the exact
 * legacy `simple-git` call, so behaviour never regresses. That happens when:
 * - the repository sets `core.untrackedCache=false`;
 * - the filesystem is not one where directory mtimes are known to be reliable
 *   (the cache depends on them), unless the repository opts in via
 *   `core.untrackedCache=true` or `feature.manyFiles`;
 * - the index is split (`core.splitIndex`), missing, or rewritten mid-copy;
 * - the git dir is not writable, or any fast-path step fails (the fast path
 *   then pauses for a cooldown);
 * - the private copy has not been warmed yet and the real index changed less
 *   than `indexSettleMs` ago. Building the cache costs about 15% more than a
 *   plain scan, once, so the first warm-up waits until the index looks stable
 *   enough for later reads to recoup it.
 */
import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { FileStatusResult, SimpleGit, StatusResult } from 'simple-git';

import { worktreeSimpleGit } from '../config/system-paths.js';
import { parseBooleanConfig } from './git-config.js';
import {
  chunkedLiteralPathspecArgs,
  withDefaultPathspecParsing,
} from './git-pathspec.js';

/** Which path produced a status result. */
export type WorktreeStatusStrategy = 'untracked-cache' | 'full-scan';

export interface WorktreeStatusRead {
  status: StatusResult;
  strategy: WorktreeStatusStrategy;
  /** Why the full scan was used; `null` for the fast path. */
  fallbackReason: string | null;
}

export interface WorktreeStatusReaderOptions {
  /**
   * Minimum age of the real index before a cold private copy is warmed up.
   * See the module documentation.
   */
  indexSettleMs: number;
  /** How long repository layout and config probes are reused. */
  layoutTtlMs: number;
  /** How long the fast path stays off after an unexpected failure. */
  failureCooldownMs: number;
}

const DEFAULT_OPTIONS: WorktreeStatusReaderOptions = {
  indexSettleMs: 10_000,
  layoutTtlMs: 60_000,
  failureCooldownMs: 60_000,
};

let options: WorktreeStatusReaderOptions = { ...DEFAULT_OPTIONS };

const PRIVATE_DIR = 'elevenex';
const PRIVATE_INDEX = 'status-index';
const PRIVATE_METADATA = 'status-index.json';
const METADATA_VERSION = 1;

/**
 * `statfs` magic numbers of local filesystems that update directory mtimes
 * whenever an entry is added or removed, which the untracked cache relies on.
 * Network and FUSE filesystems are deliberately absent: Git itself only
 * trusts them after `git update-index --test-untracked-cache`.
 */
const UNTRACKED_CACHE_SAFE_FILESYSTEMS: Partial<
  Record<NodeJS.Platform, ReadonlySet<number>>
> = {
  linux: new Set([
    0xef53, // ext2/ext3/ext4
    0x58465342, // xfs
    0x9123683e, // btrfs
    0x01021994, // tmpfs
    0x794c7630, // overlayfs
    0x2fc12fc1, // zfs
    0xf2f52010, // f2fs
    0xca451a4e, // bcachefs
  ]),
  darwin: new Set([
    0x1a, // apfs
    0x11, // hfs
  ]),
};

const logger = new Logger('WorktreeStatusReader');

interface IndexSignature {
  /** Identity of one version of the index file (inode, size, mtime, ctime). */
  key: string;
  mtimeMs: number;
}

interface PrivateIndexCopy {
  /** Signature of the real index this copy was taken from. */
  source: string;
  /** Mtime of that real index, used for the settle check after restarts. */
  sourceMtimeMs: number;
  /** True once a fast read has saved the untracked cache into the copy. */
  warm: boolean;
}

interface StatusLayout {
  indexPath: string;
  privateIndexPath: string;
  metadataPath: string;
}

interface ReaderState {
  layout: StatusLayout | string | null;
  layoutResolvedAt: number;
  copy: PrivateIndexCopy | null;
  disabledUntil: number;
  disabledReason: string;
  /** Serializes fast reads so two never rewrite the private copy at once. */
  queue: Promise<unknown>;
}

const states = new Map<string, ReaderState>();

/**
 * Reads the worktree status. The result matches `simpleGit().status()`
 * (`--porcelain -b -u --null`) exactly; see the module documentation.
 *
 * @param legacyGit simple-git instance used for the full-scan fallback.
 * @param statusArgs extra `git status` options applied to both strategies,
 *   such as `--no-ahead-behind`.
 */
export async function readWorktreeStatus(
  worktreePath: string,
  legacyGit: SimpleGit = worktreeSimpleGit(worktreePath),
  statusArgs: readonly string[] = [],
): Promise<StatusResult> {
  return (await readWorktreeStatusDetailed(worktreePath, legacyGit, statusArgs))
    .status;
}

/** {@link readWorktreeStatus}, plus which strategy produced the result. */
export async function readWorktreeStatusDetailed(
  worktreePath: string,
  legacyGit: SimpleGit = worktreeSimpleGit(worktreePath),
  statusArgs: readonly string[] = [],
): Promise<WorktreeStatusRead> {
  const state = getState(worktreePath);
  if (Date.now() < state.disabledUntil) {
    return fullScan(legacyGit, state.disabledReason, statusArgs);
  }

  const run = state.queue.then(() =>
    readWithUntrackedCache(worktreePath, state, statusArgs),
  );
  state.queue = run.catch(() => undefined);

  let outcome: StatusResult | string;
  try {
    outcome = await run;
  } catch (error) {
    const reason = `fast path failed: ${describeError(error)}`;
    state.disabledUntil = Date.now() + options.failureCooldownMs;
    state.disabledReason = reason;
    state.layout = null;
    state.copy = null;
    logger.warn(
      `[${worktreePath}] ${reason}; using full scans for ${options.failureCooldownMs} ms`,
    );
    return fullScan(legacyGit, reason, statusArgs);
  }

  return typeof outcome === 'string'
    ? fullScan(legacyGit, outcome, statusArgs)
    : { status: outcome, strategy: 'untracked-cache', fallbackReason: null };
}

/**
 * Lists every path a tracked-file diff of this status can report: all
 * entries except untracked and ignored ones, plus rename sources. Use it as
 * a pathspec to stop `git diff` from re-scanning unchanged tracked files.
 */
export function trackedStatusPaths(status: StatusResult): string[] {
  const paths = new Set<string>();
  // simple-git can leave a `-z` rename as one `to\0from` string (for example
  // when a name contains a newline). No real path contains NUL, so split it.
  const add = (value: string) => {
    for (const filePath of value.split('\0')) if (filePath) paths.add(filePath);
  };
  for (const file of status.files) {
    if (file.index === '?' || file.index === '!') continue;
    add(file.path);
    if (file.from) add(file.from);
  }
  for (const file of status.renamed) {
    add(file.from);
    add(file.to);
  }
  for (const filePath of status.conflicted) add(filePath);
  return [...paths];
}

const UNCHANGED_STATUS_CODES = new Set([' ', '?', '!', '']);

/**
 * True when some entry has changes on the given side: `staged` is index
 * versus HEAD (`git diff --cached`), `unstaged` is worktree versus index
 * (`git diff`). Renames and conflicts show up in these columns too, while
 * untracked and ignored entries belong to neither diff. When this is false
 * the corresponding diff is empty and need not run.
 */
export function hasTrackedChanges(
  status: StatusResult,
  side: 'staged' | 'unstaged',
): boolean {
  return status.files.some(
    (file) =>
      !UNCHANGED_STATUS_CODES.has(
        side === 'staged' ? file.index : file.working_dir,
      ),
  );
}

/** Tunes the reader. Intended for tests; production uses the defaults. */
export function configureWorktreeStatusReader(
  overrides: Partial<WorktreeStatusReaderOptions> | null,
): void {
  options = overrides ? { ...options, ...overrides } : { ...DEFAULT_OPTIONS };
}

/** Forgets in-memory state for one worktree, or for all of them. */
export function resetWorktreeStatusReader(worktreePath?: string): void {
  if (worktreePath) states.delete(worktreePath);
  else states.clear();
}

function getState(worktreePath: string): ReaderState {
  let state = states.get(worktreePath);
  if (!state) {
    state = {
      layout: null,
      layoutResolvedAt: 0,
      copy: null,
      disabledUntil: 0,
      disabledReason: '',
      queue: Promise.resolve(),
    };
    states.set(worktreePath, state);
  }
  return state;
}

async function fullScan(
  legacyGit: SimpleGit,
  reason: string,
  statusArgs: readonly string[],
): Promise<WorktreeStatusRead> {
  return {
    status: await legacyGit.status([...statusArgs]),
    strategy: 'full-scan',
    fallbackReason: reason,
  };
}

/**
 * Runs the fast path. Returns the status, or a reason string when the full
 * scan must be used instead. Throws only on unexpected failures.
 */
async function readWithUntrackedCache(
  worktreePath: string,
  state: ReaderState,
  statusArgs: readonly string[],
): Promise<StatusResult | string> {
  const layout = await getLayout(worktreePath, state);
  if (typeof layout === 'string') return layout;

  const copy = await syncPrivateIndex(layout, state);
  if (typeof copy === 'string') return copy;
  if (!copy.warm && Date.now() - copy.sourceMtimeMs < options.indexSettleMs) {
    return 'index changed recently; waiting before building the untracked cache';
  }

  const git = worktreeSimpleGit(worktreePath, {
    config: ['core.untrackedCache=true'],
  })
    .env('GIT_INDEX_FILE', layout.privateIndexPath)
    .env('GIT_OPTIONAL_LOCKS', '1');
  const status = await git.status(['--untracked-files=normal', ...statusArgs]);
  await expandUntrackedDirectories(
    withDefaultPathspecParsing(git.env('GIT_OPTIONAL_LOCKS', '0')),
    status,
  );

  if (!copy.warm) {
    copy.warm = true;
    await writeMetadata(layout, copy);
  }
  return status;
}

async function getLayout(
  worktreePath: string,
  state: ReaderState,
): Promise<StatusLayout | string> {
  if (
    state.layout !== null &&
    Date.now() - state.layoutResolvedAt < options.layoutTtlMs
  ) {
    return state.layout;
  }
  // A cached copy stays valid across re-probes: syncPrivateIndex checks it
  // against the real index signature and the copy's existence on every read.
  const layout = await resolveLayout(worktreePath);
  state.layout = layout;
  state.layoutResolvedAt = Date.now();
  return layout;
}

async function resolveLayout(
  worktreePath: string,
): Promise<StatusLayout | string> {
  const git = worktreeSimpleGit(worktreePath);
  const [paths, config] = await Promise.all([
    git.raw([
      'rev-parse',
      '--path-format=absolute',
      '--absolute-git-dir',
      '--git-path',
      'index',
    ]),
    git.raw([
      'config',
      '--get-regexp',
      '^(core\\.untrackedcache|core\\.splitindex|feature\\.manyfiles)$',
    ]),
  ]);
  const [gitDir, indexPath] = paths.split('\n').map((line) => line.trim());
  if (!gitDir || !indexPath || !path.isAbsolute(indexPath)) {
    return 'git is too old to report absolute index paths';
  }

  const settings = parseBooleanConfig(config);
  if (settings.get('core.splitindex') === true) return 'split index';
  if (settings.get('core.untrackedcache') === false) {
    return 'core.untrackedCache=false';
  }
  const repositoryOptsIn =
    settings.get('core.untrackedcache') === true ||
    (settings.get('core.untrackedcache') === undefined &&
      settings.get('feature.manyfiles') === true);
  if (!repositoryOptsIn && !(await hasReliableDirectoryMtimes(worktreePath))) {
    return 'filesystem not known to support the untracked cache';
  }

  // `git update-index --split-index` works without the config key.
  const gitDirEntries = await fs.readdir(gitDir);
  if (gitDirEntries.some((name) => name.startsWith('sharedindex.'))) {
    return 'split index';
  }

  const privateDir = path.join(gitDir, PRIVATE_DIR);
  try {
    await fs.mkdir(privateDir, { recursive: true });
    await fs.access(privateDir, fsConstants.W_OK);
  } catch {
    return 'git dir is not writable';
  }
  return {
    indexPath,
    privateIndexPath: path.join(privateDir, PRIVATE_INDEX),
    metadataPath: path.join(privateDir, PRIVATE_METADATA),
  };
}

async function hasReliableDirectoryMtimes(
  worktreePath: string,
): Promise<boolean> {
  const allowed = UNTRACKED_CACHE_SAFE_FILESYSTEMS[process.platform];
  if (!allowed) return false;
  try {
    const { type } = await fs.statfs(worktreePath);
    return allowed.has(Number(type) >>> 0);
  } catch {
    return false;
  }
}

/**
 * Makes the private index a copy of the current real index, reusing the
 * existing copy (and its warm untracked cache) when the real index has not
 * changed. Returns a reason string when no consistent copy can be made.
 */
async function syncPrivateIndex(
  layout: StatusLayout,
  state: ReaderState,
): Promise<PrivateIndexCopy | string> {
  const source = await readIndexSignature(layout.indexPath);
  if (!source) return 'repository has no index yet';

  if (state.copy?.source === source.key) {
    if (await fileExists(layout.privateIndexPath)) return state.copy;
  } else {
    // After a backend restart the copy on disk may still match.
    const saved = await readMetadata(layout);
    if (
      saved?.source === source.key &&
      (await fileExists(layout.privateIndexPath))
    ) {
      state.copy = saved;
      return saved;
    }
  }

  const temporary = `${layout.privateIndexPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // A reflink when the filesystem supports it; a plain copy otherwise.
    await fs.copyFile(
      layout.indexPath,
      temporary,
      fsConstants.COPYFILE_FICLONE,
    );
    // Git renames a complete new index into place, so the open file was one
    // consistent version; make sure it is still the current one.
    const after = await readIndexSignature(layout.indexPath);
    if (after?.key !== source.key) return 'index changed while copying it';

    // Git flags entries modified at or after the index's own mtime as
    // "racily clean" and re-checks their content. A copy stamped "now" would
    // hide that; a whole-second stamp no newer than the original keeps every
    // such entry flagged.
    const stamp = new Date(Math.floor(source.mtimeMs / 1000) * 1000);
    await fs.utimes(temporary, stamp, stamp);
    await fs.rename(temporary, layout.privateIndexPath);
  } finally {
    await fs.rm(temporary, { force: true });
  }

  const copy: PrivateIndexCopy = {
    source: source.key,
    sourceMtimeMs: source.mtimeMs,
    warm: false,
  };
  state.copy = copy;
  await writeMetadata(layout, copy);
  return copy;
}

async function readIndexSignature(
  indexPath: string,
): Promise<IndexSignature | null> {
  try {
    const stat = await fs.stat(indexPath, { bigint: true });
    return {
      key: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(
        ':',
      ),
      mtimeMs: Number(stat.mtimeMs),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readMetadata(
  layout: StatusLayout,
): Promise<PrivateIndexCopy | null> {
  try {
    const parsed: unknown = JSON.parse(
      await fs.readFile(layout.metadataPath, 'utf8'),
    );
    return isPrivateIndexMetadata(parsed)
      ? {
          source: parsed.source,
          sourceMtimeMs: parsed.sourceMtimeMs,
          warm: parsed.warm,
        }
      : null;
  } catch {
    // Missing or unreadable metadata just means a fresh copy.
    return null;
  }
}

function isPrivateIndexMetadata(
  value: unknown,
): value is PrivateIndexCopy & { version: number } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === METADATA_VERSION &&
    typeof record.source === 'string' &&
    typeof record.sourceMtimeMs === 'number' &&
    typeof record.warm === 'boolean'
  );
}

async function writeMetadata(
  layout: StatusLayout,
  copy: PrivateIndexCopy,
): Promise<void> {
  const temporary = `${layout.metadataPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(
      temporary,
      JSON.stringify({ version: METADATA_VERSION, ...copy }),
    );
    await fs.rename(temporary, layout.metadataPath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replaces each collapsed `?? dir/` entry with the untracked files inside
 * it, reproducing `--untracked-files=all`. `ls-files --others` applies the
 * same exclude rules as status, keeps nested repositories as a single
 * `dir/` entry like status does, and only walks the given directories.
 */
async function expandUntrackedDirectories(
  git: SimpleGit,
  status: StatusResult,
): Promise<void> {
  const directories = status.not_added.filter((entry) => entry.endsWith('/'));
  if (directories.length === 0) return;

  const owners = new Set(directories);
  const contents = new Map<string, string[]>(
    directories.map((directory) => [directory, []]),
  );
  for (const pathspec of chunkedLiteralPathspecArgs(directories)) {
    const output = await git.raw([
      'ls-files',
      '-z',
      '--others',
      '--exclude-standard',
      '--full-name',
      ...pathspec,
    ]);
    for (const listed of output.split('\0')) {
      // simple-git trims each status record, so a trailing space is dropped
      // from untracked paths; keep both strategies byte-identical.
      const filePath = listed.trimEnd();
      if (!filePath) continue;
      const owner = owningDirectory(filePath, owners);
      if (owner) contents.get(owner)!.push(filePath);
    }
  }

  status.not_added = status.not_added.flatMap((entry) =>
    owners.has(entry) ? contents.get(entry)! : [entry],
  );
  status.files = status.files.flatMap((file): FileStatusResult[] =>
    file.index === '?' && owners.has(file.path)
      ? contents
          .get(file.path)!
          .map((filePath) => ({ path: filePath, index: '?', working_dir: '?' }))
      : [file],
  );
}

/** Finds the collapsed directory (`a/b/`) that contains `filePath`. */
function owningDirectory(
  filePath: string,
  directories: ReadonlySet<string>,
): string | null {
  for (
    let slash = filePath.indexOf('/');
    slash !== -1;
    slash = filePath.indexOf('/', slash + 1)
  ) {
    const candidate = filePath.slice(0, slash + 1);
    if (directories.has(candidate)) return candidate;
  }
  return null;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n', 1)[0]?.slice(0, 200) || 'unknown error';
}
