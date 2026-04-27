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
      } as FileChangeEvent);
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
      expect(ignoredFn('/test/worktree/node_modules/@scope/package')).toBe(true);
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

    it('should allow normal paths', () => {
      const worktreePath = '/test/worktree';

      service.watchWorktree(worktreePath, jest.fn());

      const watchConfig = (chokidar.watch as jest.Mock).mock.calls[0][1];
      const ignoredFn = watchConfig.ignored;

      // Test normal paths are NOT ignored
      expect(ignoredFn('/test/worktree/src/file.ts')).toBe(false);
      expect(ignoredFn('/test/worktree/package.json')).toBe(false);
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