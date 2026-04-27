import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import chokidar, { FSWatcher } from 'chokidar';
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
 * Options for configuring the file watcher.
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
 * Check if a file path should be ignored.
 * Ignores node_modules and hidden files/directories (starting with .).
 *
 * @param filePath - The absolute file path to check
 * @returns true if the path should be ignored, false otherwise
 */
function shouldIgnorePath(filePath: string): boolean {
  // Ignore node_modules directories
  if (filePath.includes('node_modules')) {
    return true;
  }

  // Ignore hidden files and directories (starting with .)
  // This includes .git, .env, .hidden, etc.
  const pathParts = filePath.split('/');
  if (pathParts.some((part) => part.startsWith('.'))) {
    return true;
  }

  return false;
}

/**
 * Service for watching file system changes in worktree directories.
 * Uses chokidar for efficient cross-platform file watching.
 *
 * Features:
 * - Monitors worktree directories for file changes
 * - Handles atomic writes and chunked writes correctly
 * - Excludes node_modules and hidden files
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
  /** Map of worktree paths to their active FSWatcher instances */
  private watchers = new Map<string, FSWatcher>();

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
  watchWorktree(worktreePath: string, onEvent: (event: FileChangeEvent) => void): void {
    // Don't create duplicate watchers for the same worktree
    if (this.watchers.has(worktreePath)) {
      return;
    }

    // Create watcher with chokidar configuration
    const watcher = chokidar.watch(worktreePath, {
      ignored: shouldIgnorePath,
      ...DEFAULT_WATCHER_OPTIONS,
    });

    // Handle all file system events
    watcher.on('all', (event: string, absolutePath: string) => {
      // Security: Validate path is within worktree (prevents traversal attacks)
      if (!isWithinWorktree(worktreePath, absolutePath)) {
        return;
      }

      // Compute relative path from worktree root
      const relativePath = path.relative(worktreePath, absolutePath);

      // Create and emit the file change event
      const fileChangeEvent: FileChangeEvent = {
        event: event as FileEventType,
        path: relativePath,
        worktreePath,
      };

      // Invoke the callback with the event
      onEvent(fileChangeEvent);
    });

    // Store the watcher for later cleanup
    this.watchers.set(worktreePath, watcher);
  }

  /**
   * Stop watching a worktree directory and clean up resources.
   * If the worktree is not being watched, this method returns gracefully.
   *
   * @param worktreePath - Absolute path to the worktree root
   * @returns Promise that resolves when the watcher is closed
   */
  unwatchWorktree(worktreePath: string): Promise<void> {
    const watcher = this.watchers.get(worktreePath);

    // Return gracefully if not watching this worktree
    if (!watcher) {
      return Promise.resolve();
    }

    // Close the watcher and remove from map
    return watcher.close().then(() => {
      this.watchers.delete(worktreePath);
    });
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
    // Close all active watchers in parallel
    const closePromises = Array.from(this.watchers.values()).map((watcher) =>
      watcher.close(),
    );

    // Wait for all watchers to close, then clear the map
    return Promise.all(closePromises).then(() => {
      this.watchers.clear();
    });
  }
}