import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { clearWorktreeFingerprintCache } from '../git/git-worktree-fingerprint.js';
import {
  WorktreeChangeObserver,
  generatedPath,
  safeRelativePath,
} from './worktree-change-observer.js';
import { git, nulStrings, renderPatch } from './worktree-content-diff.js';
import {
  changedTreePaths,
  findRebaseBaseline,
  type RebaseBaseline,
} from './worktree-rebase.js';
import {
  UNKNOWN_IGNORED_FILE_BASELINE,
  type TurnChangeDetails,
  type TurnChangedFile,
} from './turn-change-stats.js';

const FILE_BYTES = 256 * 1024;
const BOUNDARY_BYTES = 8 * 1024 * 1024;
const TURN_PATCH_BYTES = 6 * 1024 * 1024;
const COMMAND_PATHS = 128;
const COMMAND_BYTES = 512 * 1024;
const COMMAND_WINDOW_MS = 120_000;
const JOURNAL_PATHS = 20_000;
const CONCURRENCY = 8;
/** A cold ignored-file inventory can take tens of seconds in a large checkout.
 * Turns wait briefly so small repositories keep complete ignored-file diffs,
 * while prompt acceptance never depends on finishing that directory walk. */
const IGNORED_INVENTORY_WAIT_MS = 2_000;
interface SavedFile {
  signature: string;
  mode: string;
  content?: Buffer;
  reason?: string;
  references: number;
}
interface Inventory {
  head: string | null;
  paths: Set<string>;
  ignoredInventory: boolean;
}
interface Boundary {
  head: string | null;
  files: Map<string, SavedFile | null>;
  /** Whether ignored files were inventoried when this state was read. */
  ignoredInventory: boolean;
}
export interface WorktreeCommandCapture {
  readonly turn: WorktreeTurnCapture;
  readonly paths: Set<string>;
  readonly before: Map<string, SavedFile | null>;
  readonly baselineReady: Promise<void>;
  readonly head?: Promise<string | null | undefined>;
  readonly priorPaths: Set<string>;
  readonly targets?: ReadonlySet<string>;
  readonly started: number;
  readonly expires: number;
  shared: boolean;
  partial: boolean;
}

export interface WorktreeTurnCapture {
  baseline: Boundary;
  paths: Set<string>;
  shared: boolean;
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
 * Git distinguishes a rebase's checkout transition from edits around it.
 * No private index, git add, refs, hooks, objects or user index are written.
 */
export class WorktreeChangeTracker {
  private readonly cache = new Map<string, SavedFile>();
  private cacheBytes = 0;
  private readonly turns = new Set<WorktreeTurnCapture>();
  private readonly commands = new Set<WorktreeCommandCapture>();
  private readonly commandWork = new Set<Promise<unknown>>();
  private readonly ignoredFiles = new Set<string>();
  private ignoredInventorySettled = false;
  private ignoredInventory?: Promise<void>;
  private watcherStartup?: Promise<void>;
  private readonly lifetime = new AbortController();
  private observer?: WorktreeChangeObserver;
  private inventoryInFlight?: Promise<Inventory>;
  private boundaryInFlight?: Promise<Boundary>;
  private latestBoundary?: Boundary;
  private closed = false;
  private observerFailed = false;
  private statusInvalidation?: NodeJS.Timeout;
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
        .replace(/\r?\n$/, ''),
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
    // Observation starts in the background; close() owns its cancellation.
    tracker.watcherStartup = tracker.startWatcher();
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
      baseline: { head: null, files: new Map(), ignoredInventory: false },
      paths: new Set(),
      shared: this.turns.size > 0,
    };
    if (this.turns.size) {
      for (const turn of this.turns) turn.shared = true;
      for (const command of this.commands) command.shared = true;
    }
    this.turns.add(capture);
    try {
      if (this.ignoredInventory && !this.ignoredInventorySettled) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          this.ignoredInventory,
          new Promise<void>((done) => {
            timer = setTimeout(done, IGNORED_INVENTORY_WAIT_MS);
          }),
        ]);
        clearTimeout(timer);
      }
      capture.baseline = await this.boundary();
      this.retainBoundary(capture.baseline);
      // Give the advisory watcher a brief chance to arm in a small checkout.
      for (
        let attempt = 0;
        attempt < 5 &&
        !this.observer?.ready &&
        !this.observerFailed &&
        !this.closed;
        attempt++
      )
        await delay(10);
      return capture;
    } catch (error) {
      this.turns.delete(capture);
      throw error;
    }
  }

  notePaths(paths: readonly string[]): void {
    for (const path of paths) this.observe(path);
  }

  beginCommand(
    turn: WorktreeTurnCapture,
    targets?: readonly string[],
    beforeExecution = false,
  ): WorktreeCommandCapture | undefined {
    if (this.closed || turn.finished || turn.cancelled || !this.turns.has(turn))
      return;
    const priorPaths = targets ? new Set<string>() : new Set(turn.paths);
    const previous =
      targets ??
      [
        ...new Set(
          [...priorPaths].reverse().concat([...turn.baseline.files.keys()]),
        ),
      ].slice(0, COMMAND_PATHS);
    const before = new Map<string, SavedFile | null>();
    const quota = { bytes: COMMAND_BYTES };
    const started = Date.now();
    const head = targets ? undefined : this.readHead().catch(() => undefined);
    const command: WorktreeCommandCapture = {
      turn,
      before,
      priorPaths,
      targets: targets ? new Set(targets) : undefined,
      paths: new Set(),
      started,
      expires: started + COMMAND_WINDOW_MS,
      shared: turn.shared || this.commands.size > 0,
      partial: !targets && (!this.observer?.ready || this.observerFailed),
      head,
      baselineReady: Promise.all([
        head,
        bounded(previous, async (path) => {
          const file = await this.read(path, quota);
          // An asynchronous start notification can reach us after the write.
          // Do not use a new version for a path already seen in this window.
          if (!beforeExecution && command.paths.has(path)) {
            if (file) this.release(file);
            command.partial = true;
          } else before.set(path, file);
        }),
      ]).then(() => undefined),
    };
    for (const active of this.commands) active.shared = true;
    this.commands.add(command);
    return command;
  }

  endCommand(
    command: WorktreeCommandCapture,
  ): Promise<{ files: TurnChangedFile[]; partial: boolean }> {
    return this.trackCommandWork(this.finishCommand(command));
  }

  discardCommand(command: WorktreeCommandCapture): void {
    if (!this.commands.delete(command)) return;
    void this.trackCommandWork(
      command.baselineReady.finally(() => this.releaseCommand(command)),
    ).catch(() => undefined);
  }

  private trackCommandWork<T>(pending: Promise<T>): Promise<T> {
    this.commandWork.add(pending);
    void pending
      .finally(() => this.commandWork.delete(pending))
      .catch(() => undefined);
    return pending;
  }

  private async finishCommand(command: WorktreeCommandCapture) {
    // A short drain admits notifications already queued by the OS. If a new
    // command starts during this interval both observations are marked shared.
    if (!command.targets) await delay(25);
    if (!this.commands.delete(command)) return { files: [], partial: true };
    const { turn, before } = command;
    const files: TurnChangedFile[] = [];
    const originals = new Map<string, SavedFile>();
    const current = new Map<string, SavedFile | null>();
    try {
      await command.baselineReady;
      if (this.closed || turn.cancelled || Date.now() > command.expires)
        return { files, partial: true };
      const paths = [...new Set([...command.paths, ...before.keys()])].sort();
      if (!paths.length)
        return {
          files,
          partial: command.partial || (!command.targets && this.observerFailed),
        };
      const endingHead = command.head
        ? this.readHead().catch(() => undefined)
        : undefined;
      const readBudget = { bytes: COMMAND_BYTES };
      // Freeze postimages before Git or patch rendering can widen this window.
      await bounded(paths, async (path) => {
        current.set(path, await this.read(path, readBudget));
      });
      const commandHead = await command.head;
      const startHead =
        commandHead === undefined ? turn.baseline.head : commandHead;
      const rebase = await this.commandRebase(startHead, await endingHead);
      const unseen = paths.filter(
        (path) =>
          !before.has(path) &&
          (!turn.baseline.files.has(path) || startHead !== turn.baseline.head),
      );
      await this.loadOriginals(originals, startHead, unseen, rebase?.baseline);
      // Git can distinguish a genuinely new untracked path from ignored files
      // whose preimages were outside the initial inventory.
      const ignored = await this.ignored(
        unseen.filter((path) => !originals.has(path)),
      );
      const patchBudget = { bytes: COMMAND_BYTES };
      for (const path of paths) {
        if (turn.cancelled || this.closed) return { files: [], partial: true };
        if (
          rebase &&
          !before.has(path) &&
          !turn.baseline.files.has(path) &&
          !rebase.baseline.earlierPaths.has(path) &&
          !rebase.dirtyPaths.has(path) &&
          !rebase.committedPaths.has(path) &&
          !ignored.has(path)
        )
          continue;
        if (
          !before.has(path) &&
          (command.targets || command.priorPaths.has(path) || ignored.has(path))
        ) {
          command.partial = true;
          continue;
        }
        const old = before.has(path)
          ? before.get(path)
          : startHead === turn.baseline.head && turn.baseline.files.has(path)
            ? turn.baseline.files.get(path)
            : originals.get(path);
        const after = current.get(path);
        const file = await this.compare(
          path,
          old,
          after,
          command.shared,
          patchBudget,
          'Changes observed during this command',
        );
        if (file) {
          // Match exact observed transitions across overlapping windows. The
          // after version identity prevents collapsing a later identical edit.
          if ((!old || old.content) && (!after || after.content))
            file.observationKey = createHash('sha256')
              .update(old?.mode ?? 'absent')
              .update('\0')
              .update(old?.content ?? '')
              .update('\0')
              .update(after?.signature ?? 'absent')
              .digest('hex');
          files.push(file);
        }
      }
      return {
        files,
        partial: command.partial || (!command.targets && this.observerFailed),
      };
    } finally {
      this.releaseCommand(command);
      this.releaseBoundary({ files: current });
      for (const file of originals.values()) this.release(file);
    }
  }

  private async commandRebase(
    startHead: string | null,
    endHead: string | null | undefined,
  ) {
    if (!endHead) return;
    const baseline = await findRebaseBaseline(
      this.root,
      startHead,
      endHead,
      this.lifetime.signal,
    );
    if (!baseline) return;
    try {
      const end = await this.inventory();
      if (end.head !== endHead) return;
      const committedPaths = await changedTreePaths(
        this.root,
        baseline.head,
        endHead,
        this.lifetime.signal,
      );
      return {
        baseline,
        dirtyPaths: end.paths,
        committedPaths: new Set(committedPaths),
      };
    } catch {
      // A command's filesystem snapshots still provide a usable comparison.
    }
  }

  private releaseCommand(command: WorktreeCommandCapture): void {
    this.releaseBoundary({ files: command.before });
    command.before.clear();
    command.paths.clear();
    command.priorPaths.clear();
  }

  private async ignored(paths: string[]): Promise<Set<string>> {
    if (!paths.length) return new Set();
    const safe: string[] = [];
    await bounded(paths, async (path) => {
      const parent = resolve(this.root, path, '..');
      const physical = await realpath(parent).catch(() => null);
      if (physical === parent) safe.push(path);
    });
    if (!safe.length) return new Set();
    const result = await git(
      this.root,
      ['check-ignore', '--stdin', '-z'],
      Buffer.from(safe.map((path) => `./${path}`).join('\0') + '\0'),
      [0, 1],
      this.lifetime.signal,
    );
    return new Set(nulStrings(result).map((path) => path.slice(2)));
  }

  private async compare(
    path: string,
    before: SavedFile | null | undefined,
    after: SavedFile | null | undefined,
    shared: boolean,
    quota: { bytes: number },
    label: string,
  ): Promise<TurnChangedFile | undefined> {
    if (!before && !after) return;
    if (
      before &&
      after &&
      before.mode === after.mode &&
      (before.signature === after.signature ||
        (before.content &&
          after.content &&
          before.content.equals(after.content)))
    )
      return;
    const old = before ? before.content : Buffer.alloc(0);
    const next = after ? after.content : Buffer.alloc(0);
    let reason = before?.reason ?? after?.reason;
    let patch: string | undefined;
    let additions = 0;
    let deletions = 0;
    if (old && next) {
      if (old.includes(0) || next.includes(0)) reason = 'Binary file changed';
      else if (!quota.bytes)
        reason = 'Inline diffs reached the capture size limit';
      else {
        const rendered = await renderPatch(
          path,
          old.toString('utf8'),
          next.toString('utf8'),
        );
        if (rendered) {
          ({ additions, deletions } = rendered);
          const bytes = Buffer.byteLength(rendered.patch);
          if (bytes <= quota.bytes) {
            patch = rendered.patch;
            quota.bytes -= bytes;
          } else {
            quota.bytes = 0;
            reason = 'Inline diffs reached the capture size limit';
          }
        } else
          reason = 'The diff could not be generated from the captured contents';
      }
    }
    return {
      path,
      status: !before ? 'created' : !after ? 'deleted' : 'modified',
      additions,
      deletions,
      attribution: shared ? 'shared' : 'observed',
      diffUnavailable: reason,
      hunks: [
        {
          id: `filesystem:${path}`,
          toolName: 'Filesystem',
          label,
          oldString: '',
          newString: '',
          additions,
          deletions,
          patch,
        },
      ],
    };
  }

  finish(
    capture: WorktreeTurnCapture,
    drain?: Promise<unknown>,
  ): Promise<TurnChangeDetails> {
    const pending = this.finishCapture(capture, drain);
    this.finishing.add(pending);
    void pending
      .finally(() => this.finishing.delete(pending))
      .catch(() => undefined);
    return pending;
  }

  private async finishCapture(
    capture: WorktreeTurnCapture,
    drain?: Promise<unknown>,
  ): Promise<TurnChangeDetails> {
    if (this.closed || capture.finished || !this.turns.has(capture))
      throw new Error('Turn change capture is no longer active');
    capture.finished = true;
    try {
      const end = await this.inventory();
      const rebase = await findRebaseBaseline(
        this.root,
        capture.baseline.head,
        end.head,
        this.lifetime.signal,
      );
      const paths = new Set(capture.baseline.files.keys());
      // Without an inventoried starting state, an ignored file present at the
      // end is not known to be new. Only journaled edits mark those changed.
      for (const path of end.paths)
        if (capture.baseline.ignoredInventory || !this.ignoredFiles.has(path))
          paths.add(path);
      const unknownOriginals = new Set<string>();
      const journal: string[] = [];
      await bounded(
        [...capture.paths].filter(
          (path) => safeRelativePath(path) && !paths.has(path),
        ),
        async (path) => {
          const parent = resolve(this.root, path, '..');
          if ((await realpath(parent).catch(() => null)) === parent)
            journal.push(path);
        },
      );
      const ignored = await this.ignored(journal);
      for (const path of journal) {
        // Clean tracked paths written by the rebase need no content reads.
        // Committed edits outside the rebase are added by the tree diff below.
        if (rebase && !ignored.has(path)) continue;
        paths.add(path);
        if (!ignored.has(path)) continue;
        if (generatedPath(path)) {
          paths.delete(path);
          continue;
        }
        unknownOriginals.add(path);
        if (this.ignoredFiles.size < JOURNAL_PATHS) this.ignoredFiles.add(path);
        else this.observerFailed = true;
      }
      const comparisonHead = rebase?.head ?? capture.baseline.head;
      if (rebase) for (const path of rebase.earlierPaths) paths.add(path);
      if (comparisonHead !== end.head) {
        if (comparisonHead && end.head) {
          for (const path of await changedTreePaths(
            this.root,
            comparisonHead,
            end.head,
            this.lifetime.signal,
          ))
            paths.add(path);
        } else if (comparisonHead || end.head) {
          for (const path of nulStrings(
            await git(
              this.root,
              [
                'ls-tree',
                '-r',
                '--name-only',
                '-z',
                (comparisonHead ?? end.head)!,
              ],
              undefined,
              [0],
              this.lifetime.signal,
            ),
          ))
            paths.add(path);
        }
      }
      const supportedPaths = [...paths]
        .filter((path) => safeRelativePath(path) && path.length <= 1000)
        .sort();
      const limited =
        supportedPaths.length !== paths.size ||
        supportedPaths.length > JOURNAL_PATHS;
      const candidates = supportedPaths.slice(0, JOURNAL_PATHS);
      if (capture.cancelled || this.closed)
        throw new Error('Change capture was cancelled');
      const cleanPaths = candidates.filter(
        (path) => !capture.baseline.files.has(path),
      );
      const current = await this.readVersions(candidates);
      const filesChanged: TurnChangedFile[] = [];
      const unchangedPaths: string[] = [];
      const patchBudget = { bytes: TURN_PATCH_BYTES };
      const originals = new Map<string, SavedFile>();
      try {
        await this.loadOriginals(
          originals,
          capture.baseline.head,
          cleanPaths,
          rebase,
        );
        for (const [index, path] of candidates.entries()) {
          if (capture.cancelled || this.closed)
            throw new Error('Change capture was cancelled');
          const after = current.get(path);
          const before = capture.baseline.files.has(path)
            ? capture.baseline.files.get(path)
            : (originals.get(path) ??
              (unknownOriginals.has(path) && after
                ? {
                    signature: 'unknown',
                    mode: after.mode,
                    references: 0,
                    reason: UNKNOWN_IGNORED_FILE_BASELINE,
                  }
                : undefined));
          const file = await this.compare(
            path,
            before,
            after,
            capture.shared,
            patchBudget,
            'Changes during this turn',
          );
          if (file) filesChanged.push(file);
          else unchangedPaths.push(path);
          if (index % CONCURRENCY === CONCURRENCY - 1)
            await new Promise<void>((done) => setImmediate(done));
        }
      } finally {
        this.releaseBoundary({ files: current });
        for (const file of originals.values()) this.release(file);
      }
      if (filesChanged.length || capture.baseline.head !== end.head)
        clearWorktreeFingerprintCache(this.root);
      // A turn can overlap after the endpoint scan began, while patches render.
      if (capture.shared)
        for (const file of filesChanged) file.attribution = 'shared';
      const notices = [
        ...(limited ? ['The worktree comparison reached its file limit.'] : []),
        ...(!capture.baseline.ignoredInventory
          ? [
              'Ignored files were still being inventoried when this turn started; their changes may be incomplete.',
            ]
          : []),
        ...(this.observerFailed
          ? [
              'Filesystem observation was unavailable; changes were reconciled at turn boundaries.',
            ]
          : []),
      ];
      return {
        files: filesChanged.length,
        additions: filesChanged.reduce((n, file) => n + file.additions, 0),
        deletions: filesChanged.reduce((n, file) => n + file.deletions, 0),
        filesChanged,
        capture: {
          root: this.root,
          complete: !limited,
          shared: capture.shared,
          unchangedPaths,
          ...(notices.length ? { message: notices.join(' ') } : {}),
        },
      };
    } finally {
      await drain?.catch(() => undefined);
      this.turns.delete(capture);
      this.releaseBoundary(capture.baseline);
    }
  }

  cancel(capture: WorktreeTurnCapture): void {
    capture.cancelled = true;
    for (const command of this.commands)
      if (command.turn === capture) this.discardCommand(command);
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

  private inventory(): Promise<Inventory> {
    if (this.inventoryInFlight) return this.inventoryInFlight;
    const pending = this.readInventory();
    this.inventoryInFlight = pending;
    void pending
      .finally(() => {
        if (this.inventoryInFlight === pending)
          this.inventoryInFlight = undefined;
      })
      .catch(() => undefined);
    return pending;
  }

  private async readInventory(): Promise<Inventory> {
    const status = nulStrings(
      await git(
        this.root,
        [
          'status',
          '--porcelain=v2',
          '-z',
          '--branch',
          '--no-ahead-behind',
          '--no-renames',
          '--untracked-files=all',
          '--ignore-submodules=all',
        ],
        undefined,
        [0],
        this.lifetime.signal,
      ),
    );
    const oid = status
      .find((record) => record.startsWith('# branch.oid '))
      ?.slice(13);
    if (!oid) throw new Error('Git status omitted the current revision');
    const paths = new Set(this.ignoredFiles);
    for (const record of status) {
      const fields =
        record[0] === '1'
          ? 8
          : record[0] === 'u'
            ? 10
            : record[0] === '?'
              ? 1
              : 0;
      if (!fields) continue;
      let position = -1;
      for (let field = 0; field < fields; field++)
        position = record.indexOf(' ', position + 1);
      const path = record.slice(position + 1);
      if (safeRelativePath(path)) paths.add(path);
    }
    return {
      head: oid === '(initial)' ? null : oid,
      paths,
      ignoredInventory: this.ignoredInventorySettled,
    };
  }

  private async readBoundary(): Promise<Boundary> {
    const { head, paths, ignoredInventory } = await this.inventory();
    if (paths.size > JOURNAL_PATHS)
      throw new Error('Starting state exceeds the path limit');
    const files = await this.readVersions([...paths]);
    try {
      const verifiedHead = await this.readHead();
      if (verifiedHead !== head)
        throw new Error('The checkout changed revisions during capture');
      return { head, files, ignoredInventory };
    } catch (error) {
      this.releaseBoundary({ files });
      throw error;
    }
  }

  private async readHead(): Promise<string | null> {
    const output = await git(
      this.root,
      ['rev-parse', '--verify', '-q', 'HEAD'],
      undefined,
      [0, 1],
      this.lifetime.signal,
    );
    return output.toString('utf8').trim() || null;
  }

  private async readVersions(
    paths: string[],
  ): Promise<Map<string, SavedFile | null>> {
    const files = new Map<string, SavedFile | null>();
    const quota = { bytes: BOUNDARY_BYTES };
    try {
      await bounded(paths, async (path) => {
        files.set(path, await this.read(path, quota));
      });
      return files;
    } catch (error) {
      this.releaseBoundary({ files });
      throw error;
    }
  }

  private async read(
    path: string,
    quota: { bytes: number },
  ): Promise<SavedFile | null> {
    if (this.closed || !safeRelativePath(path)) return null;
    const absolute = resolve(this.root, path);
    // Refuse symlinked ancestors rather than reading files outside the checkout.
    try {
      const parent = await realpath(resolve(absolute, '..'));
      const local = relative(this.root, parent);
      if (
        parent !== resolve(absolute, '..') ||
        isAbsolute(local) ||
        local === '..' ||
        local.startsWith(`..${sep}`)
      )
        return null;
      const info = await lstat(absolute);
      if (!info.isFile() && !info.isSymbolicLink()) {
        this.forget(path);
        return null;
      }
      const signature = `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      const cached = this.cache.get(path);
      if (
        cached?.signature === signature &&
        (cached.content || info.size > FILE_BYTES)
      ) {
        cached.references++;
        return cached;
      }
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
    file.references++; // The cache and the caller each own a lease.
    this.cache.set(path, file);
    this.cacheBytes += file.content?.length ?? 0;
    while (
      this.cacheBytes > 16 * 1024 * 1024 ||
      this.cache.size > JOURNAL_PATHS
    )
      this.forget(this.cache.keys().next().value!);
    return file;
  }

  private async loadOriginals(
    originals: Map<string, SavedFile>,
    head: string | null,
    paths: string[],
    rebase?: RebaseBaseline,
  ): Promise<void> {
    const quota = { bytes: BOUNDARY_BYTES };
    if (head) {
      const earlier = rebase
        ? paths.filter((path) => rebase.earlierPaths.has(path))
        : paths;
      for (const [path, file] of await this.originalFiles(head, earlier, quota))
        originals.set(path, file);
    }
    if (rebase) {
      const later = paths.filter((path) => !rebase.earlierPaths.has(path));
      for (const [path, file] of await this.originalFiles(
        rebase.head,
        later,
        quota,
      ))
        originals.set(path, file);
    }
  }

  private async originalFiles(
    head: string,
    paths: string[],
    quota: { bytes: number },
  ): Promise<Map<string, SavedFile>> {
    const files = new Map<string, SavedFile>();
    const blobs = new Map<
      string,
      { oid: string; mode: string; size: number }
    >();
    for (let offset = 0; offset < paths.length; offset += 128) {
      const listing = await git(
        this.root,
        [
          'ls-tree',
          '-r',
          '-l',
          '-z',
          head,
          '--',
          ...paths.slice(offset, offset + 128),
        ],
        undefined,
        [0],
        this.lifetime.signal,
      );
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
      else if (blob.size > quota.bytes || !this.budget.reserve(blob.size))
        reason =
          'Content omitted because the snapshot reached its memory limit';
      else {
        bytes += blob.size;
        quota.bytes -= blob.size;
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
          [0],
          this.lifetime.signal,
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
  private releaseBoundary(boundary: Pick<Boundary, 'files'>): void {
    for (const file of boundary.files.values()) if (file) this.release(file);
  }
  private release(file: SavedFile): void {
    if (--file.references === 0 && file.content)
      this.budget.release(file.content.length);
  }

  private observe(path: string | null): void {
    if (path === null) {
      this.observerFailed = true;
      return;
    }
    const local = sep === '\\' ? path.replaceAll('\\', '/') : path;
    if (!safeRelativePath(local) || generatedPath(local)) return;
    if (!this.statusInvalidation) {
      // A watcher burst only invalidates cached Git metadata. Selected-task
      // readers still coalesce and run on their existing refresh schedule.
      clearWorktreeFingerprintCache(this.root);
      this.statusInvalidation = setTimeout(() => {
        this.statusInvalidation = undefined;
        clearWorktreeFingerprintCache(this.root);
      }, 50);
      this.statusInvalidation.unref();
    }
    for (const command of this.commands) {
      if (
        Date.now() > command.expires ||
        (command.targets && !command.targets.has(local))
      )
        continue;
      if (command.paths.size < COMMAND_PATHS || command.paths.has(local))
        command.paths.add(local);
      else command.partial = true;
    }
    for (const turn of this.turns) {
      if (turn.paths.size < JOURNAL_PATHS) turn.paths.add(local);
      else this.observerFailed = true; // Boundary reconciliation remains authoritative.
    }
  }

  private async startWatcher(): Promise<void> {
    const inventory = git(
      this.root,
      [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
        '-z',
      ],
      undefined,
      [0],
      this.lifetime.signal,
    ).then((output) => {
      const paths = nulStrings(output);
      for (const path of paths)
        if (
          !path.endsWith('/') &&
          safeRelativePath(path) &&
          !generatedPath(path) &&
          this.ignoredFiles.size < JOURNAL_PATHS
        )
          this.ignoredFiles.add(path);
      return paths;
    });
    this.ignoredInventory = inventory.then(
      () => {
        this.ignoredInventorySettled = true;
      },
      () => undefined,
    );
    try {
      const ignored = await inventory;
      if (this.closed) return;
      this.observer = await WorktreeChangeObserver.start(
        this.root,
        ignored,
        this.lifetime.signal,
        (path) => this.observe(path),
        () => {
          this.observerFailed = true;
        },
      );
    } catch {
      this.observerFailed = true;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    clearTimeout(this.statusInvalidation);
    await this.watcherStartup;
    await this.observer?.close();
    await this.boundaryInFlight?.catch(() => undefined);
    await this.inventoryInFlight?.catch(() => undefined);
    for (const command of this.commands) this.discardCommand(command);
    await Promise.allSettled([...this.commandWork]);
    await Promise.allSettled([...this.finishing]);
    for (const capture of this.turns) this.releaseBoundary(capture.baseline);
    this.turns.clear();
    if (this.latestBoundary) this.releaseBoundary(this.latestBoundary);
    this.latestBoundary = undefined;
    for (const file of this.cache.values()) this.release(file);
    this.cache.clear();
  }
}

async function bounded<T>(
  items: readonly T[],
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
