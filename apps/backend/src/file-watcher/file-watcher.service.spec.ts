import { Test, TestingModule } from '@nestjs/testing';
import { FileWatcherService, FileChangeEvent } from './file-watcher.service.js';
import chokidar from 'chokidar';
import * as path from 'node:path';

// Mock chokidar
jest.mock('chokidar');

interface MockWatcher {
  on: jest.Mock<
    MockWatcher,
    [event: string, listener: (...args: unknown[]) => void]
  >;
  close: jest.Mock<Promise<void>, []>;
}

describe('FileWatcherService', () => {
  let service: FileWatcherService;
  let mockWatcher: MockWatcher;

  beforeEach(async () => {
    // Create mock watcher
    mockWatcher = {
      on: jest.fn().mockReturnThis(),
      close: jest.fn().mockResolvedValue(undefined),
    };

    // Mock chokidar.watch to return our mock watcher
    (chokidar.watch as jest.Mock).mockReturnValue(mockWatcher);

    const module: TestingModule = await Test.createTestingModule({
      providers: [FileWatcherService],
    }).compile();

    service = module.get<FileWatcherService>(FileWatcherService);

    // Force the chokidar backend for the shared suite so behaviour is identical
    // across platforms. The native recursive backend is covered separately.
    (
      service as unknown as { useNativeRecursiveWatch: boolean }
    ).useNativeRecursiveWatch = false;
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe('watchWorktree', () => {
    it.each(['/build/project', '/dist/project', '/test/build', '/test/dist'])(
      'matches ignores relative to checkout %s',
      (root) => {
        const onEvent = jest.fn();
        service.watchWorktree(root, onEvent);
        const ignored = (chokidar.watch as jest.Mock).mock.calls[0][1].ignored;
        expect(ignored(root)).toBe(false);
        expect(ignored(`${root}/src/main.ts`)).toBe(false);
        expect(ignored(`${root}/build/main.js`)).toBe(true);
        expect(ignored(`${root}/dist/main.js`)).toBe(true);
      },
    );

    it('should create FSWatcher for valid worktree path', () => {
      const worktreePath = '/test/worktree';
      const onEvent = jest.fn();

      service.watchWorktree(worktreePath, onEvent);

      expect(chokidar.watch).toHaveBeenCalledWith(worktreePath, {
        ignored: expect.any(Function),
        awaitWriteFinish: true,
        atomic: true,
        ignoreInitial: true,
        persistent: true,
      });
      expect(mockWatcher.on).toHaveBeenCalledWith('all', expect.any(Function));
    });

    it('should not create duplicate watcher for same worktree', () => {
      const worktreePath = '/test/worktree';
      const onEvent = jest.fn();

      service.watchWorktree(worktreePath, onEvent);
      service.watchWorktree(worktreePath, onEvent);

      expect(chokidar.watch).toHaveBeenCalledTimes(1);
    });

    it('should emit events with correct format', () => {
      const worktreePath = '/test/worktree';
      const onEvent = jest.fn();
      const filePath = '/test/worktree/src/file.ts';

      service.watchWorktree(worktreePath, onEvent);

      // Get the callback registered with watcher.on('all')
      const allCallback = mockWatcher.on.mock.calls.find(
        (call) => call[0] === 'all',
      )?.[1];

      // Simulate a file change event
      if (allCallback) {
        allCallback('change', filePath);
      }

      expect(onEvent).toHaveBeenCalledWith({
        event: 'change',
        path: path.join('src', 'file.ts'),
        worktreePath,
      });
    });

    it('should ignore paths outside worktree', () => {
      const worktreePath = '/test/worktree';
      const onEvent = jest.fn();
      const outsidePath = '/other/path/file.ts';

      service.watchWorktree(worktreePath, onEvent);

      const allCallback = mockWatcher.on.mock.calls.find(
        (call) => call[0] === 'all',
      )?.[1];

      if (allCallback) {
        allCallback('change', outsidePath);
      }

      expect(onEvent).not.toHaveBeenCalled();
    });
  });

  describe('ignored pattern', () => {
    it('should exclude node_modules paths', () => {
      const worktreePath = '/test/worktree';

      service.watchWorktree(worktreePath, jest.fn());

      const watchConfig = (chokidar.watch as jest.Mock).mock.calls[0][1];
      const ignoredFn = watchConfig.ignored;

      // Test node_modules exclusion
      expect(ignoredFn('/test/worktree/node_modules/package')).toBe(true);
      expect(ignoredFn('/test/worktree/node_modules/@scope/package')).toBe(
        true,
      );
    });

    it('watches project dotfiles while excluding Git internals and generated directories', () => {
      const worktreePath = '/test/worktree';

      service.watchWorktree(worktreePath, jest.fn());

      const watchConfig = (chokidar.watch as jest.Mock).mock.calls[0][1];
      const ignoredFn = watchConfig.ignored;

      // Configuration must update in the editor just like other source files.
      expect(ignoredFn('/test/worktree/.git')).toBe(true);
      expect(ignoredFn('/test/worktree/.env')).toBe(false);
      expect(ignoredFn('/test/worktree/.agents/skills/SKILL.md')).toBe(false);
      expect(ignoredFn('/test/worktree/.next/cache')).toBe(true);
      expect(ignoredFn('/test/worktree/src/.hidden')).toBe(false);
    });

    it('should exclude dependency and build output directories', () => {
      const worktreePath = '/test/worktree';

      service.watchWorktree(worktreePath, jest.fn());

      const watchConfig = (chokidar.watch as jest.Mock).mock.calls[0][1];
      const ignoredFn = watchConfig.ignored;

      expect(ignoredFn('/test/worktree/vendor/github.com/pkg')).toBe(true);
      expect(ignoredFn('/test/worktree/dist/main.js')).toBe(true);
      expect(ignoredFn('/test/worktree/build/output')).toBe(true);
      expect(ignoredFn('/test/worktree/target/debug')).toBe(true);
      expect(ignoredFn('/test/worktree/out/bundle')).toBe(true);
      expect(ignoredFn('/test/worktree/coverage/lcov.info')).toBe(true);
    });

    it('should allow normal paths', () => {
      const worktreePath = '/test/worktree';

      service.watchWorktree(worktreePath, jest.fn());

      const watchConfig = (chokidar.watch as jest.Mock).mock.calls[0][1];
      const ignoredFn = watchConfig.ignored;

      // Test normal paths are NOT ignored
      expect(ignoredFn('/test/worktree/src/file.ts')).toBe(false);
      expect(ignoredFn('/test/worktree/package.json')).toBe(false);
    });

    it('should match ignored names by segment, not substring', () => {
      const worktreePath = '/test/worktree';

      service.watchWorktree(worktreePath, jest.fn());

      const watchConfig = (chokidar.watch as jest.Mock).mock.calls[0][1];
      const ignoredFn = watchConfig.ignored;

      // "out"/"build" appear as substrings but not as standalone segments
      expect(ignoredFn('/test/worktree/src/checkout/file.ts')).toBe(false);
      expect(ignoredFn('/test/worktree/src/build.ts')).toBe(false);
    });
  });

  describe('error handling', () => {
    it('contains synchronous polling fallback failures without retaining an active owner', () => {
      service.watchWorktree('/test/worktree', jest.fn());
      const errorHandler = mockWatcher.on.mock.calls.find(
        ([event]) => event === 'error',
      )![1];
      (chokidar.watch as jest.Mock).mockImplementationOnce(() => {
        throw new Error('polling failed');
      });
      expect(() =>
        errorHandler(Object.assign(new Error('EMFILE'), { code: 'EMFILE' })),
      ).not.toThrow();
      expect(service.isWatching('/test/worktree')).toBe(false);
    });

    it('should register an error listener on the watcher', () => {
      service.watchWorktree('/test/worktree', jest.fn());

      expect(mockWatcher.on).toHaveBeenCalledWith(
        'error',
        expect.any(Function),
      );
    });

    it('should not throw when the watcher emits an EMFILE error', () => {
      service.watchWorktree('/test/worktree', jest.fn());

      const errorHandler = mockWatcher.on.mock.calls.find(
        (call) => call[0] === 'error',
      )?.[1];

      const emfile = Object.assign(new Error('EMFILE: too many open files'), {
        code: 'EMFILE',
      });

      expect(() => errorHandler?.(emfile)).not.toThrow();
    });

    it('should fall back to polling when the watcher hits EMFILE', () => {
      service.watchWorktree('/test/worktree', jest.fn());

      const errorHandler = mockWatcher.on.mock.calls.find(
        (call) => call[0] === 'error',
      )?.[1];

      const emfile = Object.assign(new Error('EMFILE: too many open files'), {
        code: 'EMFILE',
      });
      errorHandler?.(emfile);

      // The exhausted watcher is closed and a second (polling) watcher created.
      expect(mockWatcher.close).toHaveBeenCalled();
      expect(chokidar.watch).toHaveBeenCalledTimes(2);
      const pollingConfig = (chokidar.watch as jest.Mock).mock.calls[1][1];
      expect(pollingConfig.usePolling).toBe(true);
      expect(pollingConfig.interval).toBeGreaterThan(0);
    });
  });

  describe('native recursive watch (macOS/Windows)', () => {
    it('ignores generated children relative to a checkout under build', async () => {
      jest.useFakeTimers();
      let notify!: (event: string, filename: string) => void;
      const native = { on: jest.fn().mockReturnThis(), close: jest.fn() };
      jest
        .spyOn(require('node:fs'), 'watch')
        .mockImplementation(
          (_root: unknown, _options: unknown, callback: typeof notify) => {
            notify = callback;
            return native;
          },
        );
      jest
        .spyOn(require('node:fs/promises'), 'stat')
        .mockResolvedValue({ isDirectory: () => false });
      (
        service as unknown as { useNativeRecursiveWatch: boolean }
      ).useNativeRecursiveWatch = true;
      const events = jest.fn();
      service.watchWorktree('/build/checkout', events);
      notify('change', 'dist/generated.js');
      notify('change', 'src/main.ts');
      await jest.advanceTimersByTimeAsync(50);
      expect(events).toHaveBeenCalledTimes(1);
      expect(events).toHaveBeenCalledWith(
        expect.objectContaining({ path: path.join('src', 'main.ts') }),
      );
    });

    it('suppresses a native stat result from a detached watcher after reconnect', async () => {
      jest.useFakeTimers();
      let notify!: (event: string, filename: string) => void;
      jest
        .spyOn(require('node:fs'), 'watch')
        .mockImplementation(
          (_root: unknown, _options: unknown, callback: typeof notify) => {
            notify = callback;
            return { on: jest.fn().mockReturnThis(), close: jest.fn() };
          },
        );
      let finishStat!: (stats: unknown) => void;
      jest.spyOn(require('node:fs/promises'), 'stat').mockReturnValue(
        new Promise((resolve) => {
          finishStat = resolve;
        }),
      );
      (
        service as unknown as { useNativeRecursiveWatch: boolean }
      ).useNativeRecursiveWatch = true;
      const oldEvents = jest.fn();
      const newEvents = jest.fn();
      service.watchWorktree('/test/checkout', oldEvents);
      notify('change', 'main.ts');
      await jest.advanceTimersByTimeAsync(50);
      await service.unwatchWorktree('/test/checkout');
      service.watchWorktree('/test/checkout', newEvents);
      finishStat({ isDirectory: () => false });
      await Promise.resolve();
      await Promise.resolve();
      expect(oldEvents).not.toHaveBeenCalled();
      expect(newEvents).not.toHaveBeenCalled();
    });

    it('should fall back to polling when native watcher creation throws', () => {
      const worktreePath = '\\\\wsl.localhost\\Debian\\home\\user\\repo\\';
      const nativeFailure = Object.assign(
        new Error('EISDIR: illegal operation on a directory'),
        { code: 'EISDIR' },
      );
      const nativeWatcherSpy = jest
        .spyOn(
          service as unknown as {
            createNativeWatcher: () => never;
          },
          'createNativeWatcher',
        )
        .mockImplementation(() => {
          throw nativeFailure;
        });
      (
        service as unknown as { useNativeRecursiveWatch: boolean }
      ).useNativeRecursiveWatch = true;

      expect(() =>
        service.watchWorktree(worktreePath, jest.fn()),
      ).not.toThrow();

      expect(nativeWatcherSpy).toHaveBeenCalled();
      expect(chokidar.watch).toHaveBeenCalledWith(
        worktreePath,
        expect.objectContaining({ usePolling: true }),
      );
      expect(service.isWatching(worktreePath)).toBe(true);
    });

    it('should keep the backend alive when native and fallback watchers both fail', () => {
      const worktreePath = '\\\\wsl.localhost\\Debian\\home\\user\\repo\\';
      jest
        .spyOn(
          service as unknown as {
            createNativeWatcher: () => never;
          },
          'createNativeWatcher',
        )
        .mockImplementation(() => {
          throw new Error('native watcher failed');
        });
      (chokidar.watch as jest.Mock).mockImplementation(() => {
        throw new Error('fallback watcher failed');
      });
      (
        service as unknown as { useNativeRecursiveWatch: boolean }
      ).useNativeRecursiveWatch = true;

      expect(() =>
        service.watchWorktree(worktreePath, jest.fn()),
      ).not.toThrow();
      expect(service.isWatching(worktreePath)).toBe(false);
    });

    it('should classify an existing file as a change event', async () => {
      const onEvent = jest.fn();
      const worktreePath = '/test/worktree';

      await (
        service as unknown as {
          emitNativeEvent: (
            worktreePath: string,
            absolutePath: string,
            onEvent: (event: FileChangeEvent) => void,
          ) => Promise<void>;
        }
      ).emitNativeEvent(worktreePath, __filename, onEvent);

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'change', worktreePath }),
      );
    });

    it('should classify a directory as an addDir event', async () => {
      const onEvent = jest.fn();
      const worktreePath = '/test/worktree';

      await (
        service as unknown as {
          emitNativeEvent: (
            worktreePath: string,
            absolutePath: string,
            onEvent: (event: FileChangeEvent) => void,
          ) => Promise<void>;
        }
      ).emitNativeEvent(worktreePath, __dirname, onEvent);

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'addDir', worktreePath }),
      );
    });

    it('should classify a missing path as an unlink event', async () => {
      const onEvent = jest.fn();
      const worktreePath = '/test/worktree';

      await (
        service as unknown as {
          emitNativeEvent: (
            worktreePath: string,
            absolutePath: string,
            onEvent: (event: FileChangeEvent) => void,
          ) => Promise<void>;
        }
      ).emitNativeEvent(
        worktreePath,
        '/test/worktree/does-not-exist.ts',
        onEvent,
      );

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'unlink',
          path: 'does-not-exist.ts',
          worktreePath,
        }),
      );
    });
  });

  describe('unwatchWorktree', () => {
    it('retains a reconnected watcher when the old deferred close completes', async () => {
      let finishClose!: () => void;
      mockWatcher.close.mockReturnValueOnce(
        new Promise((resolve) => {
          finishClose = resolve;
        }),
      );
      const replacement = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn().mockResolvedValue(undefined),
      };
      const oldEvents = jest.fn();
      const newEvents = jest.fn();
      const root = '/test/worktree';
      service.watchWorktree(root, oldEvents);
      const oldAll = mockWatcher.on.mock.calls.find(
        ([event]) => event === 'all',
      )![1];
      const oldError = mockWatcher.on.mock.calls.find(
        ([event]) => event === 'error',
      )![1];
      const closing = service.unwatchWorktree(root);
      expect(service.isWatching(root)).toBe(false);

      (chokidar.watch as jest.Mock).mockReturnValueOnce(replacement);
      service.watchWorktree(root, newEvents);
      oldAll('change', `${root}/stale.ts`);
      oldError(Object.assign(new Error('late EMFILE'), { code: 'EMFILE' }));
      finishClose();
      await closing;

      expect(service.isWatching(root)).toBe(true);
      expect(service.getActiveWatcherCount()).toBe(1);
      expect(chokidar.watch).toHaveBeenCalledTimes(2);
      expect(oldEvents).not.toHaveBeenCalled();
      replacement.on.mock.calls.find(([event]) => event === 'all')![1](
        'change',
        `${root}/current.ts`,
      );
      expect(newEvents).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'current.ts' }),
      );
    });

    it('should close watcher and remove from map', async () => {
      const worktreePath = '/test/worktree';
      service.watchWorktree(worktreePath, jest.fn());

      await service.unwatchWorktree(worktreePath);

      expect(mockWatcher.close).toHaveBeenCalled();
      // Verify watcher is removed - trying to watch again should create new watcher
      service.watchWorktree(worktreePath, jest.fn());
      expect(chokidar.watch).toHaveBeenCalledTimes(2);
    });

    it('should resolve gracefully if worktree not being watched', async () => {
      const result = await service.unwatchWorktree('/not/watched');
      expect(result).toBeUndefined();
      expect(mockWatcher.close).not.toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('awaits detached closes and all active watchers even when a close rejects', async () => {
      let finishClose!: () => void;
      mockWatcher.close.mockReturnValueOnce(
        new Promise((resolve) => {
          finishClose = resolve;
        }),
      );
      service.watchWorktree('/test/old', jest.fn());
      void service.unwatchWorktree('/test/old');
      const rejecting = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn().mockRejectedValue(new Error('close failed')),
      };
      (chokidar.watch as jest.Mock).mockReturnValueOnce(rejecting);
      service.watchWorktree('/test/new', jest.fn());
      let complete = false;
      const shutdown = service.onModuleDestroy().then(() => {
        complete = true;
      });
      service.watchWorktree('/test/late', jest.fn());
      await Promise.resolve();
      expect(complete).toBe(false);
      expect(rejecting.close).toHaveBeenCalledTimes(1);
      expect(service.getActiveWatcherCount()).toBe(0);
      finishClose();
      await shutdown;
      expect(complete).toBe(true);
      expect(mockWatcher.close).toHaveBeenCalledTimes(1);
      expect(chokidar.watch).toHaveBeenCalledTimes(2);
    });

    it('should close all active watchers', async () => {
      const path1 = '/test/worktree1';
      const path2 = '/test/worktree2';

      // Create separate mock watchers for each path
      const mockWatcher1 = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn().mockResolvedValue(undefined),
      };
      const mockWatcher2 = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn().mockResolvedValue(undefined),
      };

      (chokidar.watch as jest.Mock)
        .mockReturnValueOnce(mockWatcher1)
        .mockReturnValueOnce(mockWatcher2);

      service.watchWorktree(path1, jest.fn());
      service.watchWorktree(path2, jest.fn());

      await service.onModuleDestroy();

      expect(mockWatcher1.close).toHaveBeenCalled();
      expect(mockWatcher2.close).toHaveBeenCalled();
    });

    it('should reject new watchers after shutdown', async () => {
      const worktreePath = '/test/worktree';
      service.watchWorktree(worktreePath, jest.fn());

      await service.onModuleDestroy();

      expect(service.getActiveWatcherCount()).toBe(0);
      service.watchWorktree(worktreePath, jest.fn());
      expect(chokidar.watch).toHaveBeenCalledTimes(1);
    });
  });

  describe('onModuleInit', () => {
    it('should initialize without errors', () => {
      expect(service.onModuleInit()).toBeUndefined();
    });
  });

  describe('event types', () => {
    it('should emit add event for new files', () => {
      const worktreePath = '/test/worktree';
      const onEvent = jest.fn();
      const filePath = '/test/worktree/new-file.ts';

      service.watchWorktree(worktreePath, onEvent);

      const allCallback = mockWatcher.on.mock.calls.find(
        (call) => call[0] === 'all',
      )?.[1];

      if (allCallback) {
        allCallback('add', filePath);
      }

      expect(onEvent).toHaveBeenCalledWith({
        event: 'add',
        path: 'new-file.ts',
        worktreePath,
      });
    });

    it('should emit unlink event for deleted files', () => {
      const worktreePath = '/test/worktree';
      const onEvent = jest.fn();
      const filePath = '/test/worktree/deleted-file.ts';

      service.watchWorktree(worktreePath, onEvent);

      const allCallback = mockWatcher.on.mock.calls.find(
        (call) => call[0] === 'all',
      )?.[1];

      if (allCallback) {
        allCallback('unlink', filePath);
      }

      expect(onEvent).toHaveBeenCalledWith({
        event: 'unlink',
        path: 'deleted-file.ts',
        worktreePath,
      });
    });

    it('should emit addDir and unlinkDir events', () => {
      const worktreePath = '/test/worktree';
      const onEvent = jest.fn();

      service.watchWorktree(worktreePath, onEvent);

      const allCallback = mockWatcher.on.mock.calls.find(
        (call) => call[0] === 'all',
      )?.[1];

      if (allCallback) {
        allCallback('addDir', '/test/worktree/new-dir');
        allCallback('unlinkDir', '/test/worktree/old-dir');
      }

      expect(onEvent).toHaveBeenCalledTimes(2);
      expect(onEvent).toHaveBeenNthCalledWith(1, {
        event: 'addDir',
        path: 'new-dir',
        worktreePath,
      });
      expect(onEvent).toHaveBeenNthCalledWith(2, {
        event: 'unlinkDir',
        path: 'old-dir',
        worktreePath,
      });
    });
  });
});
