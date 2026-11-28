import { watch } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import chokidar from 'chokidar';
import { git, nulStrings } from './worktree-content-diff.js';

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

export function safeRelativePath(path: string): boolean {
  return (
    !!path &&
    !isAbsolute(path) &&
    path !== '..' &&
    !path
      .split(sep === '\\' ? /[\\/]/ : '/')
      .some((part) => part === '..' || part === '.git') &&
    !path.includes('\0')
  );
}

export function generatedPath(path: string): boolean {
  return path.split('/').some((part) => GENERATED_DIRECTORIES.has(part));
}

/** One advisory recursive observer per active checkout. Git boundary reads
 * reconcile missed events, watcher startup gaps and ref/index changes. */
export class WorktreeChangeObserver {
  ready = false;
  private watcher?: { close(): unknown };

  static async start(
    root: string,
    ignoredPaths: readonly string[],
    signal: AbortSignal,
    observe: (path: string | null) => void,
    failed: () => void,
  ): Promise<WorktreeChangeObserver> {
    const observer = new WorktreeChangeObserver();
    if (process.platform === 'darwin' || process.platform === 'win32') {
      const watcher = watch(
        root,
        { recursive: true, persistent: false },
        (_event, path) => observe(path?.toString() ?? null),
      );
      watcher.on('error', failed);
      observer.watcher = watcher;
      observer.ready = true;
      return observer;
    }
    const ignored = new Set(
      ignoredPaths
        .filter((path) => path.endsWith('/') && generatedPath(path))
        .map((path) => path.slice(0, -1)),
    );
    // Tracked files inside ignored trees still belong to the checkout.
    const tracked = new Set(
      nulStrings(await git(root, ['ls-files', '-z'], undefined, [0], signal)),
    );
    signal.throwIfAborted();
    const parents = new Set<string>();
    for (const path of tracked) {
      const parts = path.split('/');
      while (parts.pop() && parts.length) parents.add(parts.join('/'));
    }
    const watcher = chokidar.watch(root, {
      ignoreInitial: true,
      persistent: false,
      followSymlinks: false,
      atomic: false,
      ignored: (path: string) => {
        const local = relative(root, path);
        if (local.split('/').includes('.git')) return true;
        if (tracked.has(local) || parents.has(local)) return false;
        let ancestor = local;
        while (ancestor) {
          if (ignored.has(ancestor)) return true;
          const slash = ancestor.lastIndexOf('/');
          ancestor = slash < 0 ? '' : ancestor.slice(0, slash);
        }
        return false;
      },
    });
    watcher.on('ready', () => {
      observer.ready = true;
    });
    watcher.on('all', (_event: string, path: string) =>
      observe(relative(root, path)),
    );
    watcher.on('error', () => {
      failed();
      void watcher.close();
    });
    observer.watcher = watcher;
    return observer;
  }

  async close(): Promise<void> {
    await this.watcher?.close();
    this.watcher = undefined;
  }
}
