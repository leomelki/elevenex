import { Test, TestingModule } from '@nestjs/testing';
import { FileWatcherService, FileChangeEvent } from './file-watcher.service.js';
import chokidar, { FSWatcher } from 'chokidar';
import * as path from 'node:path';

// Mock chokidar
jest.mock('chokidar');

describe('FileWatcherService', () => {
  let service: FileWatcherService;
  let mockWatcher: jest.Mocked<FSWatcher>;

  beforeEach(async () => {
    // Create mock watcher
    mockWatcher = {
      on: jest.fn().mockReturnThis(),
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<FSWatcher>;

    // Mock chokidar.watch to return our mock watcher
    (chokidar.watch as jest.Mock).mockReturnValue(mockWatcher);

    const module: TestingModule = await Test.createTestingModule({
      providers: [FileWatcherService],
    }).compile();

    service = module.get<FileWatcherService>(FileWatcherService);

    // Force the chokidar backend for the shared suite so behaviour is identical
    // across platforms. The native recursive backend is covered separately.
    (service as unknown as { useNativeRecursiveWatch: boolean }).useNativeRecursiveWatch =
      false;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('watchWorktree', () => {
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
        path: 'src/file.ts',
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

    it('should exclude hidden files and directories', () => {
      const worktreePath = '/test/worktree';

      service.watchWorktree(worktreePath, jest.fn());

      const watchConfig = (chokidar.watch as jest.Mock).mock.calls[0][1];
      const ignoredFn = watchConfig.ignored;

      // Test hidden files/dirs (starting with .)
      expect(ignoredFn('/test/worktree/.git')).toBe(true);
      expect(ignoredFn('/test/worktree/.env')).toBe(true);
      expect(ignoredFn('/test/worktree/src/.hidden')).toBe(true);
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
    it('should close all active watchers', async () => {
      const path1 = '/test/worktree1';
      const path2 = '/test/worktree2';

      // Create separate mock watchers for each path
      const mockWatcher1 = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn().mockResolvedValue(undefined),
      } as unknown as jest.Mocked<FSWatcher>;
      const mockWatcher2 = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn().mockResolvedValue(undefined),
      } as unknown as jest.Mocked<FSWatcher>;

      (chokidar.watch as jest.Mock)
        .mockReturnValueOnce(mockWatcher1)
        .mockReturnValueOnce(mockWatcher2);

      service.watchWorktree(path1, jest.fn());
      service.watchWorktree(path2, jest.fn());

      await service.onModuleDestroy();

      expect(mockWatcher1.close).toHaveBeenCalled();
      expect(mockWatcher2.close).toHaveBeenCalled();
    });

    it('should clear watchers map after closing', async () => {
      const worktreePath = '/test/worktree';
      service.watchWorktree(worktreePath, jest.fn());

      await service.onModuleDestroy();

      // After destroy, watching same path should create new watcher
      (chokidar.watch as jest.Mock).mockReturnValue(mockWatcher);
      service.watchWorktree(worktreePath, jest.fn());
      expect(chokidar.watch).toHaveBeenCalled();
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
