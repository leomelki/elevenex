import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import chokidar from 'chokidar';
import { watch as fsWatch } from 'node:fs';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { isWithinWorktree } from '../files/files.service.js';

/**
 * File change event emitted by the FileWatcherService.
 * Contains the event type, relative path, and worktree path.
 */
export interface FileChangeEvent {
  /** The type of file system event */
  event: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
  /** Relative path from the worktree root */
  path: string;
  /** Absolute path to the worktree root */
  worktreePath: string;
}

/**
 * Valid file system event types that can be watched.
 */
export type FileEventType = FileChangeEvent['event'];

/**
 * Handle to an active worktree watcher, regardless of the underlying backend
 * (native recursive fs.watch or chokidar). Closing releases all OS resources.
 */
interface WorktreeWatcher {
  close(): Promise<void>;
}

interface WatcherRegistration {
  watcher?: WorktreeWatcher;
}

/**
 * Options for configuring the chokidar fallback watcher.
 */
interface WatcherOptions {
  /** Whether to wait for write operations to finish before emitting events */
  awaitWriteFinish: boolean;
  /** Whether to handle atomic writes (mv operations) */
  atomic: boolean;
  /** Whether to ignore initial scan events */
  ignoreInitial: boolean;
  /** Whether to keep the watcher persistent */
  persistent: boolean;
}

/**
 * Default watcher configuration for chokidar.
 * Handles atomic writes, chunked writes, and ignores initial scan.
 */
const DEFAULT_WATCHER_OPTIONS: WatcherOptions = {
  awaitWriteFinish: true, // Wait for chunked writes to complete
  atomic: true, // Handle atomic writes from editors
  ignoreInitial: true, // Don't emit events for existing files on start
  persistent: true, // Keep watching until explicitly closed
};

/**
 * Debounce window (ms) used to coalesce the bursty events that native fs.watch
 * emits for chunked or atomic writes, so a single save produces a single event.
 */
const NATIVE_EVENT_DEBOUNCE_MS = 50;

/**
 * Poll interval (ms) for the chokidar polling fallback used on file-descriptor
 * constrained systems where the default watch backend hits EMFILE.
 */
const POLLING_INTERVAL_MS = 300;

/**
 * Directory names excluded from watching.
 *
 * These are dependency/build/generated directories that can each hold thousands
 * of sub-directories. Skipping them removes the bulk of the directory count
 * (which matters for the chokidar fallback, where every directory costs a file
 * descriptor) without hiding actual source files.
 */
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.cache',
  '.angular',
  '.turbo',
  '.venv',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
]);

/**
 * Whether the current platform can watch an entire tree with a single OS handle.
 *
 * macOS (FSEvents) and Windows (ReadDirectoryChangesW) support recursive
 * fs.watch natively — one handle covers the whole tree, so a large repository
 * costs a single file descriptor. Linux's inotify has no recursive mode (Node
 * would silently watch only the top level), so we use chokidar there instead.
 *
 * This is the root-cause fix for the EMFILE ("too many open files") crash:
 * chokidar v5 dropped the FSEvents backend and opens one fs.watch per directory,
 * which exhausts the descriptor limit on big repos (and across several worktrees
 * watched at once). Native recursive watching restores the pre-regression
 * behaviour of a single handle per worktree.
 */
function supportsRecursiveWatch(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32';
}

/**
 * Check if a file path should be ignored.
 *
 * Matches on individual path segments (never substrings) so a file such as
 * `src/checkout/build.ts` is not ignored merely because it contains "out" or
 * "build". Ignores the generated/dependency directories listed in
 * {@link IGNORED_DIRECTORIES}, including Git internals and generated dot directories.
 * Project dotfiles and configuration directories remain watchable.
 *
 * @param filePath - The path relative to the checkout root
 * @returns true if the path should be ignored, false otherwise
 */
function shouldIgnorePath(filePath: string): boolean {
  const pathParts = filePath.split(path.sep);

  return pathParts.some((part) => IGNORED_DIRECTORIES.has(part));
}

/**
 * Service for watching file system changes in worktree directories.
 *
 * Uses a single-handle recursive watcher (native fs.watch) on macOS and Windows
 * to avoid exhausting file descriptors on large repositories, and falls back to
 * chokidar (with an automatic polling fallback) on platforms without recursive
 * watch support.
 *
 * Features:
 * - Monitors worktree directories for file changes
 * - Handles atomic writes and chunked writes correctly
 * - Excludes Git internals and build/dependency/cache directories
 * - Provides lifecycle management (OnModuleInit, OnModuleDestroy)
 * - Validates paths to prevent traversal outside worktree
 *
 * @example
 * // Watch a worktree for file changes
 * fileWatcher.watchWorktree('/path/to/worktree', (event) => {
 *   console.log(`File ${event.path} changed: ${event.event}`);
 * });
 *
 * // Stop watching a worktree
 * await fileWatcher.unwatchWorktree('/path/to/worktree');
 */
@Injectable()
export class FileWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FileWatcherService.name);

  /** Map of worktree paths to their active watcher handles */
  private watchers = new Map<string, WatcherRegistration>();
  private readonly closingWatchers = new Map<WorktreeWatcher, Promise<void>>();
  private destroyed = false;
  private shutdown: Promise<void> | null = null;

  /** Worktrees for which a file-descriptor-exhaustion warning was already logged */
  private fdExhaustionWarned = new Set<string>();

  /**
   * Whether to use the native single-handle recursive watcher. Defaults to the
   * platform capability; overridable in tests to exercise either backend.
   */
  private useNativeRecursiveWatch = supportsRecursiveWatch();

  /**
   * Lifecycle hook called when the module is initialized.
   * The service is ready to accept watch requests after this.
   */
  onModuleInit(): void {
    // Service initialized, ready to accept watch requests
  }

  /**
   * Start watching a worktree directory for file changes.
   * If already watching the worktree, this method returns without action.
   *
   * @param worktreePath - Absolute path to the worktree root
   * @param onEvent - Callback function invoked when a file change occurs
   */
  watchWorktree(
    worktreePath: string,
    onEvent: (event: FileChangeEvent) => void,
  ): void {
    // Don't create duplicate watchers for the same worktree
    if (this.destroyed || this.watchers.has(worktreePath)) {
      return;
    }

    const registration: WatcherRegistration = {};
    this.watchers.set(worktreePath, registration);
    const emitIfCurrent = (event: FileChangeEvent): void => {
      if (!this.destroyed && this.watchers.get(worktreePath) === registration) {
        onEvent(event);
      }
    };
    try {
      registration.watcher = this.useNativeRecursiveWatch
        ? this.createNativeWatcherWithFallback(
            worktreePath,
            emitIfCurrent,
            registration,
          )
        : this.createChokidarWatcher(
            worktreePath,
            emitIfCurrent,
            false,
            registration,
          );
    } catch (error) {
      // fs.watch and chokidar.watch can both fail synchronously before an
      // 'error' listener can be attached (for example, native recursive watch
      // throws EISDIR for WSL UNC directories on Windows). A failed file watcher
      // must not take down the API and every other active session.
      this.watchers.delete(worktreePath);
      this.logWatcherError(worktreePath, error);
    }
  }

  /**
   * Prefer the efficient native recursive watcher, but recover from synchronous
   * construction failures by using chokidar polling. Polling avoids the native
   * directory-watch API that rejects some network and WSL-backed paths.
   */
  private createNativeWatcherWithFallback(
    worktreePath: string,
    onEvent: (event: FileChangeEvent) => void,
    registration: WatcherRegistration,
  ): WorktreeWatcher {
    try {
      return this.createNativeWatcher(worktreePath, onEvent);
    } catch (error) {
      this.logger.warn(
        `Native recursive file watcher unavailable for ${worktreePath}: ${
          error instanceof Error ? error.message : String(error)
        }; falling back to polling.`,
      );
      return this.createChokidarWatcher(
        worktreePath,
        onEvent,
        true,
        registration,
      );
    }
  }

  /**
   * Create a single-handle recursive watcher using Node's native fs.watch.
   *
   * One OS handle covers the entire tree, so the descriptor cost is constant
   * regardless of repository size — this is what prevents EMFILE. Native
   * fs.watch only reports 'rename'/'change', so events are classified into the
   * chokidar-compatible shape by stat-ing the affected path.
   */
  private createNativeWatcher(
    worktreePath: string,
    onEvent: (event: FileChangeEvent) => void,
  ): WorktreeWatcher {
    // Coalesce the burst of events a single save/atomic-write produces.
    const debounceTimers = new Map<string, NodeJS.Timeout>();
    let closed = false;

    const scheduleEmit = (absolutePath: string): void => {
      const existing = debounceTimers.get(absolutePath);
      if (existing) {
        clearTimeout(existing);
      }
      debounceTimers.set(
        absolutePath,
        setTimeout(() => {
          debounceTimers.delete(absolutePath);
          if (!closed) {
            void this.emitNativeEvent(
              worktreePath,
              absolutePath,
              onEvent,
            ).catch((error) => this.logWatcherError(worktreePath, error));
          }
        }, NATIVE_EVENT_DEBOUNCE_MS),
      );
    };

    const watcher = fsWatch(
      worktreePath,
      { recursive: true, persistent: true },
      (_eventType, filename) => {
        // filename is relative to worktreePath and may be null on some events.
        if (closed || !filename) {
          return;
        }
        const absolutePath = path.resolve(worktreePath, filename.toString());

        // Security: ignore anything resolving outside the worktree.
        if (!isWithinWorktree(worktreePath, absolutePath)) {
          return;
        }
        if (shouldIgnorePath(path.relative(worktreePath, absolutePath))) {
          return;
        }

        scheduleEmit(absolutePath);
      },
    );

    watcher.on('error', (error: unknown) =>
      this.logWatcherError(worktreePath, error),
    );

    return {
      close: () => {
        closed = true;
        for (const timer of debounceTimers.values()) {
          clearTimeout(timer);
        }
        debounceTimers.clear();
        watcher.close();
        return Promise.resolve();
      },
    };
  }

  /**
   * Classify a native fs.watch hit into the chokidar-compatible event shape.
   *
   * Native fs.watch does not say whether a path was created, modified, or
   * removed, so we stat it: an existing directory -> 'addDir', an existing file
   * -> 'change', and a missing path -> 'unlink'. The change-reflection consumer
   * reveals files on 'add'/'change' and ignores directory and unlink events, so
   * collapsing creation into 'change' preserves behaviour while avoiding the cost
   * of tracking every known path in a multi-thousand-file repository.
   */
  private async emitNativeEvent(
    worktreePath: string,
    absolutePath: string,
    onEvent: (event: FileChangeEvent) => void,
  ): Promise<void> {
    let event: FileEventType;
    try {
      const stats = await stat(absolutePath);
      event = stats.isDirectory() ? 'addDir' : 'change';
    } catch {
      // Path no longer exists -> treated as a removal.
      event = 'unlink';
    }

    onEvent({
      event,
      path: path.relative(worktreePath, absolutePath),
      worktreePath,
    });
  }

  /**
   * Create a chokidar-based watcher (fallback for platforms without recursive
   * fs.watch). chokidar opens one descriptor per directory, so on a large repo
   * with a low descriptor limit it can hit EMFILE/ENFILE; when that happens we
   * transparently re-create the watcher in polling mode, which does not hold a
   * descriptor per directory.
   *
   * @param usePolling - whether this watcher should poll instead of using native
   *   directory watches (used for the automatic EMFILE recovery path)
   */
  private createChokidarWatcher(
    worktreePath: string,
    onEvent: (event: FileChangeEvent) => void,
    usePolling: boolean,
    registration: WatcherRegistration,
  ): WorktreeWatcher {
    const watcher = chokidar.watch(worktreePath, {
      ignored: (filePath: string) =>
        shouldIgnorePath(path.relative(worktreePath, filePath)),
      ...DEFAULT_WATCHER_OPTIONS,
      // Only add polling options when polling, so the non-polling configuration
      // stays byte-for-byte identical to the original behaviour.
      ...(usePolling
        ? { usePolling: true, interval: POLLING_INTERVAL_MS }
        : {}),
    });
    const handle: WorktreeWatcher = {
      close: () => Promise.resolve(watcher.close()),
    };
    const isCurrent = (): boolean =>
      !this.destroyed &&
      this.watchers.get(worktreePath) === registration &&
      registration.watcher === handle;

    // Handle all file system events
    watcher.on('all', (event: string, absolutePath: string) => {
      // Security: Validate path is within worktree (prevents traversal attacks)
      if (!isCurrent() || !isWithinWorktree(worktreePath, absolutePath)) {
        return;
      }

      // Create and emit the file change event with a worktree-relative path
      onEvent({
        event: event as FileEventType,
        path: path.relative(worktreePath, absolutePath),
        worktreePath,
      });
    });

    // Surface watcher errors instead of letting chokidar's EventEmitter throw.
    // Without an 'error' listener, Node re-throws an emitted error as an uncaught
    // exception, which crashes the whole backend process.
    watcher.on('error', (error: unknown) => {
      if (!isCurrent()) return;
      const code = (error as NodeJS.ErrnoException)?.code;

      // File-descriptor exhaustion: recover by switching this worktree to polling
      // (which does not hold a descriptor per directory) instead of crashing.
      if ((code === 'EMFILE' || code === 'ENFILE') && !usePolling) {
        if (!this.fdExhaustionWarned.has(worktreePath)) {
          this.fdExhaustionWarned.add(worktreePath);
          this.logger.warn(
            `Open file-descriptor limit reached while watching ${worktreePath} (${code}); ` +
              `falling back to polling. Raise the open-file limit (ulimit -n) to avoid the slower polling mode.`,
          );
        }
        // Transfer ownership before closing: late errors/events from the old
        // backend must not replace or notify the current registration.
        registration.watcher = undefined;
        void this.closeWatcher(worktreePath, handle);
        try {
          registration.watcher = this.createChokidarWatcher(
            worktreePath,
            onEvent,
            true,
            registration,
          );
        } catch (fallbackError) {
          this.watchers.delete(worktreePath);
          this.logWatcherError(worktreePath, fallbackError);
        }
        return;
      }

      this.logWatcherError(worktreePath, error);
    });

    return handle;
  }

  /**
   * Log a non-fatal watcher error as a warning.
   */
  private logWatcherError(worktreePath: string, error: unknown): void {
    this.logger.warn(
      `File watcher error for ${worktreePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  /**
   * Stop watching a worktree directory and clean up resources.
   * If the worktree is not being watched, this method returns gracefully.
   *
   * @param worktreePath - Absolute path to the worktree root
   * @returns Promise that resolves when the watcher is closed
   */
  unwatchWorktree(worktreePath: string): Promise<void> {
    const registration = this.watchers.get(worktreePath);

    // Return gracefully if not watching this worktree
    if (!registration) {
      return Promise.resolve();
    }

    // Detach synchronously, so a reconnect can own a fresh watcher while this
    // backend is still releasing resources. Close completion never edits owners.
    this.watchers.delete(worktreePath);
    this.fdExhaustionWarned.delete(worktreePath);
    return registration.watcher
      ? this.closeWatcher(worktreePath, registration.watcher)
      : Promise.resolve();
  }

  private closeWatcher(
    worktreePath: string,
    watcher: WorktreeWatcher,
  ): Promise<void> {
    const existing = this.closingWatchers.get(watcher);
    if (existing) return existing;
    const closing = (async () => {
      try {
        await watcher.close();
      } catch (error) {
        this.logWatcherError(worktreePath, error);
      }
    })().finally(() => this.closingWatchers.delete(watcher));
    this.closingWatchers.set(watcher, closing);
    return closing;
  }

  /**
   * Check if a worktree is currently being watched.
   *
   * @param worktreePath - Absolute path to the worktree root
   * @returns true if the worktree is being watched, false otherwise
   */
  isWatching(worktreePath: string): boolean {
    return this.watchers.has(worktreePath);
  }

  /**
   * Get the number of active watchers.
   *
   * @returns The count of currently active watchers
   */
  getActiveWatcherCount(): number {
    return this.watchers.size;
  }

  /**
   * Lifecycle hook called when the module is destroyed.
   * Closes all active watchers to prevent resource leaks.
   *
   * @returns Promise that resolves when all watchers are closed
   */
  onModuleDestroy(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.destroyed = true;
    for (const worktreePath of this.watchers.keys()) {
      void this.unwatchWorktree(worktreePath);
    }
    this.shutdown = Promise.all(this.closingWatchers.values()).then(() => {
      this.fdExhaustionWarned.clear();
    });
    return this.shutdown;
  }
}
