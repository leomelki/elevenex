import { spawn } from 'node:child_process';
import { constants, watch } from 'node:fs';
import { lstat, mkdtemp, open, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import chokidar from 'chokidar';
import { formatPatch, parsePatch, structuredPatch } from 'diff';
import { buildAugmentedEnv } from '../config/system-paths.js';
import type {
  TurnChangeDetails,
  TurnChangedFile,
} from './turn-change-stats.js';

const FILE_BYTES = 256 * 1024;
const BOUNDARY_BYTES = 8 * 1024 * 1024;
const OUTPUT_BYTES = 32 * 1024 * 1024;
const JOURNAL_PATHS = 20_000;
const CONCURRENCY = 8;
const GENERATED_DIRECTORIES = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.cache',
]);

interface SavedFile {
  signature: string;
  mode: string;
  content?: Buffer;
  reason?: string;
  references: number;
}
interface Boundary {
  head: string | null;
  files: Map<string, SavedFile | null>;
}
export interface WorktreeTurnCapture {
  baseline: Boundary;
  paths: Set<string>;
  shared: boolean;
  startedAt: string;
  finished?: boolean;
  cancelled?: boolean;
}

/** Shared across checkouts and live turns; cached preimages have reference-counted
 * leases, so overlapping turns reuse bytes without multiplying the memory cap. */
export class ChangeContentBudget {
  private bytes = 0;
  constructor(readonly limit = 64 * 1024 * 1024) {}
  reserve(bytes: number): boolean {
    if (this.bytes + bytes > this.limit) return false;
    this.bytes += bytes;
    return true;
  }
  release(bytes: number): void {
    this.bytes -= bytes;
  }
  get usedBytes(): number {
    return this.bytes;
  }
}

/** A path journal accelerates candidate selection; Git reconciliation at each
 * boundary covers delayed/dropped watcher events, atomic saves and commits.
 * Git is used only for inventory and immutable original blobs, never ownership.
 * No private index, git add, refs, hooks, objects or user index are written.
 */
export class WorktreeChangeTracker {
  private readonly cache = new Map<string, SavedFile>();
  private cacheBytes = 0;
  private readonly turns = new Set<WorktreeTurnCapture>();
  private readonly ignoredFiles = new Set<string>();
  private watcher?: { close(): unknown };
  private boundaryInFlight?: Promise<Boundary>;
  private latestBoundary?: Boundary;
  private closed = false;
  private observerFailed = false;
  private readonly finishing = new Set<Promise<TurnChangeDetails>>();

  private constructor(
    readonly root: string,
    private readonly budget: ChangeContentBudget,
  ) {}

  static async resolveRoot(path: string): Promise<string> {
    const directory = await realpath(path);
    return realpath(
      (await git(directory, ['rev-parse', '--show-toplevel']))
        .toString('utf8')
        .trim(),
    );
  }

  static async create(
    path: string,
    budget = new ChangeContentBudget(),
  ): Promise<WorktreeChangeTracker> {
    const tracker = new WorktreeChangeTracker(
      await WorktreeChangeTracker.resolveRoot(path),
      budget,
    );
    await tracker.startWatcher();
    return tracker;
  }

  get activeTurns(): number {
    return this.turns.size;
  }

  async begin(): Promise<WorktreeTurnCapture> {
    if (this.closed) throw new Error('Change tracker is closed');
    // Reserve the observation window BEFORE asynchronous baseline acquisition.
    // Every overlapping capture is marked, including one ending during a scan.
    const capture: WorktreeTurnCapture = {
      baseline: { head: null, files: new Map() },
      paths: new Set(),
      shared: this.turns.size > 0,
      startedAt: new Date().toISOString(),
    };
    if (this.turns.size) for (const turn of this.turns) turn.shared = true;
    this.turns.add(capture);
    try {
      capture.baseline = await this.boundary();
      this.retainBoundary(capture.baseline);
      return capture;
    } catch (error) {
      this.turns.delete(capture);
      throw error;
    }
  }

  finish(capture: WorktreeTurnCapture): Promise<TurnChangeDetails> {
    const pending = this.finishCapture(capture);
    this.finishing.add(pending);
    void pending
      .finally(() => this.finishing.delete(pending))
      .catch(() => undefined);
    return pending;
  }

  private async finishCapture(
    capture: WorktreeTurnCapture,
  ): Promise<TurnChangeDetails> {
    if (this.closed || capture.finished || !this.turns.has(capture))
      throw new Error('Turn change capture is no longer active');
    capture.finished = true;
    let end: Boundary | undefined;
    try {
      end = await this.boundary();
      this.retainBoundary(end);
      const paths = new Set([
        ...capture.baseline.files.keys(),
        ...end.files.keys(),
      ]);
      const unknownOriginals = new Set<string>();
      const journal: string[] = [];
      await bounded(
        [...capture.paths].filter(safeRelativePath),
        async (path) => {
          // Git rejects pathspecs crossing symlinked directories. Real source
          // paths and tracked deletions are independently covered by status.
          const parent = resolve(this.root, path, '..');
          if ((await realpath(parent).catch(() => null)) === parent)
            journal.push(path);
        },
      );
      if (journal.length) {
        const ignored = new Set(
          nulStrings(
            await git(
              this.root,
              ['check-ignore', '--stdin', '-z'],
              Buffer.from(journal.join('\0') + '\0'),
              [0, 1],
            ),
          ),
        );
        for (const path of journal) {
          if (!ignored.has(path)) paths.add(path);
          else if (
            !path.split('/').some((part) => GENERATED_DIRECTORIES.has(part))
          ) {
            paths.add(path);
            if (!capture.baseline.files.has(path)) unknownOriginals.add(path);
            if (this.ignoredFiles.size < JOURNAL_PATHS)
              this.ignoredFiles.add(path);
            else this.observerFailed = true;
          }
        }
      }
      if (capture.baseline.head !== end.head) {
        if (capture.baseline.head && end.head) {
          const committed = await git(this.root, [
            'diff',
            '--name-only',
            '--no-renames',
            '-z',
            capture.baseline.head,
            end.head,
            '--',
          ]);
          for (const path of nulStrings(committed)) paths.add(path);
        } else if (capture.baseline.head || end.head) {
          for (const path of nulStrings(
            await git(this.root, [
              'ls-tree',
              '-r',
              '--name-only',
              '-z',
              (capture.baseline.head ?? end.head)!,
            ]),
          ))
            paths.add(path);
        }
      }
      const candidates = [...paths].filter(safeRelativePath).sort();
      if (capture.cancelled || this.closed) throw new Error('Change capture was cancelled');
      const cleanPaths = candidates.filter(
        (path) => !capture.baseline.files.has(path),
      );
      const originals = capture.baseline.head
        ? await this.originalFiles(capture.baseline.head, cleanPaths)
        : new Map<string, SavedFile>();
      const filesChanged: TurnChangedFile[] = [];
      const unchangedPaths: string[] = [];
      try {
        // Batch inventory reads, then render in deterministic order. Simple
        // comparisons stay in process; only expensive ones need a Git fallback.
        for (
          let offset = 0;
          offset < candidates.length;
          offset += CONCURRENCY
        ) {
          if (capture.cancelled || this.closed) throw new Error('Change capture was cancelled');
          const batch = candidates.slice(offset, offset + CONCURRENCY);
          const current = await Promise.all(
            batch.map(async (path) => {
              const file = await this.read(path, { bytes: BOUNDARY_BYTES });
              if (file) file.references++;
              return file;
            }),
          );
          try {
            for (const [index, path] of batch.entries()) {
              const after = current[index];
              const before = capture.baseline.files.has(path)
                ? capture.baseline.files.get(path)
                : (originals.get(path) ??
                  (unknownOriginals.has(path) && after
                    ? {
                        signature: 'unknown',
                        mode: after.mode,
                        references: 0,
                        reason:
                          'The file is ignored by Git and its starting contents were not available',
                      }
                    : undefined));
              if (!before && !after) {
                unchangedPaths.push(path);
                continue;
              }
              if (
                before &&
                after &&
                before.mode === after.mode &&
                (before === after ||
                  (before.content &&
                    after.content &&
                    before.content.equals(after.content)))
              ) {
                unchangedPaths.push(path);
                continue;
              }
              let reason = before?.reason ?? after?.reason;
              let patch: string | undefined;
              let additions = 0;
              let deletions = 0;
              const oldContent = before ? before.content : Buffer.alloc(0);
              const newContent = after ? after.content : Buffer.alloc(0);
              if (oldContent && newContent) {
                if (oldContent.includes(0) || newContent.includes(0))
                  reason = 'Binary file changed';
                else {
                  const rendered = await renderPatch(
                    path,
                    oldContent.toString('utf8'),
                    newContent.toString('utf8'),
                  );
                  if (rendered) {
                    ({ patch, additions, deletions } = rendered);
                  } else
                    reason =
                      'The diff could not be generated from the captured contents';
                }
              }
              filesChanged.push({
                path,
                status: !before ? 'created' : !after ? 'deleted' : 'modified',
                additions,
                deletions,
                attribution: capture.shared ? 'shared' : 'observed',
                diffUnavailable: reason,
                hunks: [
                  {
                    id: `filesystem:${path}`,
                    toolName: 'Filesystem',
                    label: 'Changes during this turn',
                    oldString: '',
                    newString: '',
                    additions,
                    deletions,
                    patch,
                  },
                ],
              });
            }
          } finally {
            for (const file of current) if (file) this.release(file);
          }
          // Rendering many small changes must not monopolize the backend loop.
          await new Promise<void>((done) => setImmediate(done));
        }
      } finally {
        for (const file of originals.values()) this.release(file);
      }
      return {
        files: filesChanged.length,
        additions: filesChanged.reduce((n, file) => n + file.additions, 0),
        deletions: filesChanged.reduce((n, file) => n + file.deletions, 0),
        filesChanged,
        capture: {
          root: this.root,
          complete: true,
          shared: capture.shared,
          unchangedPaths,
          ...(this.observerFailed
            ? {
                message:
                  'Filesystem observation was unavailable; changes were reconciled at turn boundaries.',
              }
            : {}),
        },
      };
    } finally {
      this.turns.delete(capture);
      this.releaseBoundary(capture.baseline);
      if (end) this.releaseBoundary(end);
    }
  }

  cancel(capture: WorktreeTurnCapture): void {
    capture.cancelled = true;
    if (capture.finished) return; // A finishing capture owns its cleanup.
    if (this.turns.delete(capture)) this.releaseBoundary(capture.baseline);
  }

  private boundary(): Promise<Boundary> {
    if (this.boundaryInFlight) return this.boundaryInFlight;
    const pending = this.readBoundary().then((boundary) => {
      if (this.latestBoundary) this.releaseBoundary(this.latestBoundary);
      this.latestBoundary = boundary;
      return boundary;
    });
    this.boundaryInFlight = pending;
    void pending
      .finally(() => {
        if (this.boundaryInFlight === pending)
          this.boundaryInFlight = undefined;
      })
      .catch(() => undefined);
    return pending;
  }

  private async head(): Promise<string | null> {
    try {
      return (await git(this.root, ['rev-parse', '--verify', 'HEAD']))
        .toString('utf8')
        .trim();
    } catch (error) {
      // Empty repositories have no HEAD but still have a useful inventory.
      if ((error as GitFailure).code === 128) return null;
      throw error;
    }
  }

  private async readBoundary(): Promise<Boundary> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const head = await this.head();
      const status = await git(this.root, [
        'status',
        '--porcelain=v1',
        '-z',
        '--no-renames',
        '--untracked-files=all',
        '--ignore-submodules=all',
      ]);
      const paths = [
        ...new Set([
          ...nulStrings(status).map((record) => record.slice(3)),
          ...this.ignoredFiles,
        ]),
      ].filter(safeRelativePath);
      const files = new Map<string, SavedFile | null>();
      const quota = { bytes: BOUNDARY_BYTES };
      try {
        await bounded(paths, async (path) => {
          const file = await this.read(path, quota);
          if (file) file.references++;
          files.set(path, file);
        });
        if (head === (await this.head())) return { head, files };
      } catch (error) {
        this.releaseBoundary({ head, files });
        throw error;
      }
      this.releaseBoundary({ head, files });
    }
    throw new Error(
      'The checkout changed revisions repeatedly while capturing its starting state',
    );
  }

  private async read(
    path: string,
    quota: { bytes: number },
  ): Promise<SavedFile | null> {
    if (!safeRelativePath(path)) return null;
    const absolute = resolve(this.root, path);
    // Refuse symlinked ancestors rather than reading files outside the checkout.
    try {
      const parent = await realpath(resolve(absolute, '..'));
      const local = relative(this.root, parent);
      if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`))
        return null;
      const info = await lstat(absolute);
      if (!info.isFile() && !info.isSymbolicLink()) {
        this.forget(path);
        return null;
      }
      const signature = `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      const cached = this.cache.get(path);
      if (cached?.signature === signature) return cached;
      const mode = info.isSymbolicLink()
        ? '120000'
        : info.mode & 0o111
          ? '100755'
          : '100644';
      let content: Buffer | undefined;
      let reason: string | undefined;
      if (info.size > FILE_BYTES)
        reason = 'File is too large for an inline diff';
      else if (info.size > quota.bytes)
        reason =
          'Content omitted because the snapshot reached its memory limit';
      else {
        quota.bytes -= info.size;
        if (info.isSymbolicLink())
          content = Buffer.from(await readlink(absolute));
        else {
          const handle = await open(
            absolute,
            constants.O_RDONLY |
              (process.platform === 'win32'
                ? 0
                : constants.O_NOFOLLOW | constants.O_NONBLOCK),
          );
          try {
            const opened = await handle.stat();
            if (
              !opened.isFile() ||
              opened.ino !== info.ino ||
              opened.dev !== info.dev
            )
              throw new Error(`File changed type during capture: ${path}`);
            const buffer = Buffer.alloc(info.size + 1);
            let read = 0;
            while (read < buffer.length) {
              const result = await handle.read(
                buffer,
                read,
                buffer.length - read,
                read,
              );
              if (!result.bytesRead) break;
              read += result.bytesRead;
            }
            const settled = await handle.stat();
            if (
              read > info.size ||
              settled.mtimeMs !== info.mtimeMs ||
              settled.ctimeMs !== info.ctimeMs
            )
              reason =
                'File was still changing while its contents were captured';
            else content = buffer.subarray(0, read);
          } finally {
            await handle.close();
          }
        }
      }
      if (content && !this.budget.reserve(content.length)) {
        content = undefined;
        reason =
          'Content omitted because change tracking reached its memory limit';
      }
      const saved: SavedFile = {
        signature,
        mode,
        content,
        reason,
        references: 1,
      };
      return this.remember(path, saved);
    } catch (error) {
      if (
        ['ENOENT', 'ENOTDIR'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      ) {
        this.forget(path);
        return null;
      }
      return this.remember(path, {
        signature: `unreadable:${Date.now()}`,
        mode: this.cache.get(path)?.mode ?? '100644',
        references: 1,
        reason: 'The file could not be read while capturing its contents',
      });
    }
  }

  private forget(path: string): void {
    const previous = this.cache.get(path);
    if (previous) {
      this.cacheBytes -= previous.content?.length ?? 0;
      this.release(previous);
      this.cache.delete(path);
    }
  }

  private remember(path: string, file: SavedFile): SavedFile {
    this.forget(path);
    this.cache.set(path, file);
    this.cacheBytes += file.content?.length ?? 0;
    while (
      this.cacheBytes > 16 * 1024 * 1024 ||
      this.cache.size > JOURNAL_PATHS
    )
      this.forget(this.cache.keys().next().value!);
    return file;
  }

  private async originalFiles(
    head: string,
    paths: string[],
  ): Promise<Map<string, SavedFile>> {
    const files = new Map<string, SavedFile>();
    const blobs = new Map<
      string,
      { oid: string; mode: string; size: number }
    >();
    for (let offset = 0; offset < paths.length; offset += 128) {
      const listing = await git(this.root, [
        'ls-tree',
        '-r',
        '-l',
        '-z',
        head,
        '--',
        ...paths.slice(offset, offset + 128),
      ]);
      for (const record of nulStrings(listing)) {
        const tab = record.indexOf('\t');
        const [mode, type, oid, size] = record
          .slice(0, tab)
          .trim()
          .split(/\s+/);
        if (tab < 0 || type !== 'blob') continue;
        blobs.set(record.slice(tab + 1), { oid, mode, size: Number(size) });
      }
    }
    let bytes = 0;
    const selected: Array<
      [string, { oid: string; mode: string; size: number }]
    > = [];
    for (const [path, blob] of blobs) {
      let reason: string | undefined;
      if (blob.size > FILE_BYTES)
        reason = 'File is too large for an inline diff';
      else if (
        bytes + blob.size > BOUNDARY_BYTES ||
        !this.budget.reserve(blob.size)
      )
        reason =
          'Content omitted because the snapshot reached its memory limit';
      else {
        bytes += blob.size;
        selected.push([path, blob]);
      }
      files.set(path, {
        signature: blob.oid,
        mode: blob.mode,
        references: 1,
        reason,
      });
    }
    try {
      if (selected.length) {
        const output = await git(
          this.root,
          ['cat-file', '--batch'],
          Buffer.from(selected.map(([, blob]) => blob.oid).join('\n') + '\n'),
        );
        let position = 0;
        for (const [path, blob] of selected) {
          const newline = output.indexOf(10, position);
          if (
            newline < 0 ||
            output.subarray(position, newline).toString('utf8') !==
              `${blob.oid} blob ${blob.size}` ||
            newline + 1 + blob.size >= output.length
          )
            throw new Error('Invalid original file response');
          files.get(path)!.content = Buffer.from(
            output.subarray(newline + 1, newline + 1 + blob.size),
          );
          position = newline + 1 + blob.size + 1;
        }
      }
      return files;
    } catch (error) {
      // Reservations not yet assigned to a file still need releasing.
      this.budget.release(bytes);
      throw error;
    }
  }

  private retainBoundary(boundary: Boundary): void {
    for (const file of boundary.files.values()) if (file) file.references++;
  }
  private releaseBoundary(boundary: Boundary): void {
    for (const file of boundary.files.values()) if (file) this.release(file);
  }
  private release(file: SavedFile): void {
    if (--file.references === 0 && file.content)
      this.budget.release(file.content.length);
  }

  private async startWatcher(): Promise<void> {
    const observe = (path: string | null) => {
      if (path === null) {
        this.observerFailed = true;
        return;
      }
      const local = path.replaceAll('\\', '/');
      if (
        !safeRelativePath(local) ||
        local
          .split('/')
          .some((part) => part === '.git' || GENERATED_DIRECTORIES.has(part))
      )
        return;
      for (const turn of this.turns) {
        if (turn.paths.size < JOURNAL_PATHS) turn.paths.add(local);
        else this.observerFailed = true; // Boundary reconciliation remains authoritative.
      }
    };
    try {
      const ignoredPaths = nulStrings(
        await git(this.root, [
          'ls-files',
          '--others',
          '--ignored',
          '--exclude-standard',
          '--directory',
          '-z',
        ]),
      );
      for (const path of ignoredPaths)
        if (
          !path.endsWith('/') &&
          safeRelativePath(path) &&
          !path.split('/').some((part) => GENERATED_DIRECTORIES.has(part))
        )
          this.ignoredFiles.add(path);
      if (process.platform === 'darwin' || process.platform === 'win32') {
        const watcher = watch(
          this.root,
          { recursive: true, persistent: false },
          (_event, path) => observe(path?.toString() ?? null),
        );
        watcher.on('error', () => {
          this.observerFailed = true;
        });
        this.watcher = watcher;
      } else {
        // Prune ignored dependency trees without hiding tracked generated files.
        const ignored = ignoredPaths.filter(
          (path) =>
            path.endsWith('/') &&
            path.split('/').some((part) => GENERATED_DIRECTORIES.has(part)),
        );
        const tracked = new Set(
          nulStrings(await git(this.root, ['ls-files', '-z'])),
        );
        const parents = new Set<string>();
        for (const path of tracked) {
          const parts = path.split('/');
          while (parts.pop() && parts.length) parents.add(parts.join('/'));
        }
        const watcher = chokidar.watch(this.root, {
          ignoreInitial: true,
          persistent: false,
          followSymlinks: false,
          ignored: (path: string) => {
            const local = relative(this.root, path).replaceAll('\\', '/');
            return (
              local.split('/').includes('.git') ||
              (!tracked.has(local) &&
                !parents.has(local) &&
                ignored.some((prefix) => `${local}/`.startsWith(prefix)))
            );
          },
        });
        watcher.on('all', (_event: string, path: string) =>
          observe(relative(this.root, path)),
        );
        watcher.on('error', () => {
          this.observerFailed = true;
          void watcher.close();
        });
        this.watcher = watcher;
        // Chokidar initialization is advisory; baseline reconciliation covers
        // its initial scan and no provider startup waits for a directory crawl.
      }
    } catch {
      this.observerFailed = true;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.watcher?.close();
    await this.boundaryInFlight?.catch(() => undefined);
    await Promise.allSettled([...this.finishing]);
    for (const capture of this.turns) this.releaseBoundary(capture.baseline);
    this.turns.clear();
    if (this.latestBoundary) this.releaseBoundary(this.latestBoundary);
    this.latestBoundary = undefined;
    for (const file of this.cache.values()) this.release(file);
    this.cache.clear();
  }
}

export function safeRelativePath(path: string): boolean {
  return (
    !!path &&
    !isAbsolute(path) &&
    path !== '..' &&
    !path.split(/[\\/]/).includes('..') &&
    !path.includes('\0')
  );
}

function nulStrings(buffer: Buffer): string[] {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

async function bounded<T>(
  items: T[],
  action: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) await action(items[next++]);
    }),
  );
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

type GitFailure = Error & { code?: number | null };

function git(
  cwd: string,
  args: string[],
  input?: Buffer,
  allowedCodes = [0],
): Promise<Buffer> {
  return new Promise((done, reject) => {
    const env = buildAugmentedEnv();
    for (const key of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_COMMON_DIR',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    ])
      delete env[key];
    env.GIT_OPTIONAL_LOCKS = '0';
    env.GIT_LITERAL_PATHSPECS = '1';
    const child = spawn('git', ['--no-optional-locks', ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error('Change capture git operation timed out');
      child.kill();
    }, 15_000);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_BYTES) {
        failure = new Error('Change capture exceeded its path inventory limit');
        child.kill();
      } else chunks.push(chunk);
    });
    // Errors must never expose repository contents or subprocess credentials.
    child.stderr.resume();
    child.stdin.on('error', () => undefined);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failure || code === null || !allowedCodes.includes(code))
        reject(
          Object.assign(
            failure ??
              new Error(`Change capture git ${args[0]} failed (${code})`),
            { code },
          ),
        );
      else done(Buffer.concat(chunks, bytes));
    });
    child.stdin.end(input);
  });
}

async function renderPatch(
  path: string,
  before: string,
  after: string,
): Promise<
  { patch: string; additions: number; deletions: number } | undefined
> {
  const rendered = await new Promise<
    { patch: string; additions: number; deletions: number } | undefined
  >((done) => {
    structuredPatch(path, path, before, after, undefined, undefined, {
      context: 3,
      timeout: 50,
      maxEditLength: 10_000,
      callback: (diff) => {
        if (!diff) return done(undefined);
        let additions = 0;
        let deletions = 0;
        for (const hunk of diff.hunks)
          for (const line of hunk.lines) {
            if (line.startsWith('+')) additions++;
            else if (line.startsWith('-')) deletions++;
          }
        done({ patch: formatPatch(diff), additions, deletions });
      },
    });
  });
  if (rendered) return rendered;

  // Keep expensive comparisons off the backend event loop. Use the captured
  // bytes, never the live checkout, so later edits cannot change this turn's diff.
  const directory = await mkdtemp(join(tmpdir(), 'elevenex-turn-diff-'));
  try {
    await Promise.all([
      writeFile(join(directory, 'before'), before, { mode: 0o600 }),
      writeFile(join(directory, 'after'), after, { mode: 0o600 }),
    ]);
    const output = await git(directory, [
      'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--text',
      '--no-color', '--diff-algorithm=myers', '--unified=3', '--', 'before', 'after',
    ], undefined, [0, 1]);
    const diff = parsePatch(output.toString('utf8'))[0];
    if (!diff) return undefined;
    diff.oldFileName = path;
    diff.newFileName = path;
    let additions = 0;
    let deletions = 0;
    for (const hunk of diff.hunks)
      for (const line of hunk.lines) {
        if (line.startsWith('+')) additions++;
        else if (line.startsWith('-')) deletions++;
      }
    return { patch: formatPatch(diff), additions, deletions };
  } catch {
    return undefined;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
