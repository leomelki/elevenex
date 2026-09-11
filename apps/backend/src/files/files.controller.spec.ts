import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as path from 'node:path';
import { FilesController, FilesystemController } from './files.controller.js';
import { FilesService } from './files.service.js';

/** Minimal Express response stand-in for the NDJSON streaming endpoint. */
interface MockResponse {
  writableEnded: boolean;
  socket: { setNoDelay: jest.Mock };
  chunks: string[];
  headers: Record<string, string>;
  statusCode?: number;
  jsonBody?: unknown;
  on: jest.Mock;
  status: jest.Mock;
  setHeader: jest.Mock;
  flushHeaders: jest.Mock;
  write: jest.Mock;
  end: jest.Mock;
  json: jest.Mock;
  emitClose: () => void;
}

describe('FilesController', () => {
  let controller: FilesController;
  let filesystemController: FilesystemController;
  let service: FilesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [FilesController, FilesystemController],
      providers: [
        {
          provide: FilesService,
          useValue: {
            stat: jest.fn(),
            suggestPaths: jest.fn(),
            searchFiles: jest.fn(),
            searchText: jest.fn(),
            searchTextStream: jest.fn(),
            listFiles: jest.fn(),
            readFile: jest.fn(),
            writeFile: jest.fn(),
            createDirectory: jest.fn(),
            rename: jest.fn(),
            deleteEntry: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<FilesController>(FilesController);
    filesystemController =
      module.get<FilesystemController>(FilesystemController);
    service = module.get<FilesService>(FilesService);
  });

  describe('createDirectory', () => {
    it('delegates path suggestions to the service', async () => {
      const suggestPaths = jest
        .fn()
        .mockResolvedValue([
          { path: '/tmp/repo', name: 'repo', kind: 'directory' },
        ]);
      service.suggestPaths = suggestPaths;

      const result = await filesystemController.suggestPaths({
        input: '/tmp/re',
        targetKind: 'directory',
        preferredStartDirectory: '/tmp',
      });

      expect(result).toEqual([
        { path: '/tmp/repo', name: 'repo', kind: 'directory' },
      ]);
      expect(suggestPaths).toHaveBeenCalledWith('/tmp/re', 'directory', '/tmp');
    });

    it('delegates to service with decoded worktree path', async () => {
      const createDirectory = jest.fn().mockResolvedValue(undefined);
      service.createDirectory = createDirectory;

      const result = await controller.createDirectory(
        encodeURIComponent('/tmp/worktree path'),
        encodeURIComponent('src/components'),
      );

      expect(result).toEqual({ success: true });
      expect(createDirectory).toHaveBeenCalledWith(
        path.join('/tmp/worktree path', 'src/components'),
        '/tmp/worktree path',
      );
    });

    it('bubbles BadRequestException', async () => {
      const createDirectory = jest
        .fn()
        .mockRejectedValue(new BadRequestException('Access denied'));
      service.createDirectory = createDirectory;

      await expect(
        controller.createDirectory(encodeURIComponent('/tmp/worktree'), 'src'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('searchFiles', () => {
    it('delegates with decoded worktree path, query, and parsed limit', async () => {
      const searchFiles = jest
        .fn()
        .mockResolvedValue([{ path: 'src/app.ts', name: 'app.ts' }]);
      service.searchFiles = searchFiles;

      const result = await controller.searchFiles(
        encodeURIComponent('/tmp/worktree path'),
        'app',
        '25',
      );

      expect(result).toEqual([{ path: 'src/app.ts', name: 'app.ts' }]);
      expect(searchFiles).toHaveBeenCalledWith(
        '/tmp/worktree path',
        'app',
        25,
      );
    });

    it('defaults missing query and limit', async () => {
      const searchFiles = jest.fn().mockResolvedValue([]);
      service.searchFiles = searchFiles;

      await controller.searchFiles(encodeURIComponent('/tmp/worktree'));

      expect(searchFiles).toHaveBeenCalledWith('/tmp/worktree', '', undefined);
    });
  });

  describe('searchText', () => {
    it('delegates with decoded worktree path and parsed search options', async () => {
      const searchText = jest.fn().mockResolvedValue([
        {
          path: 'src/app.ts',
          lineNumber: 2,
          lineText: 'const needle = true;',
          ranges: [{ start: 6, end: 12 }],
        },
      ]);
      service.searchText = searchText;

      const result = await controller.searchText(
        encodeURIComponent('/tmp/worktree path'),
        'needle',
        'false',
        'true',
        'true',
        ['src/**', 'docs/**'],
        'dist/**',
        'false',
        '50',
      );

      expect(result).toEqual([
        {
          path: 'src/app.ts',
          lineNumber: 2,
          lineText: 'const needle = true;',
          ranges: [{ start: 6, end: 12 }],
        },
      ]);
      expect(searchText).toHaveBeenCalledWith('/tmp/worktree path', {
        query: 'needle',
        isRegExp: false,
        isCaseSensitive: true,
        isWordMatch: true,
        includes: ['src/**', 'docs/**'],
        excludes: ['dist/**'],
        useIgnoreFiles: false,
        maxResults: 50,
      });
    });
  });

  describe('streamSearchText', () => {
    function createMockResponse(): MockResponse {
      const chunks: string[] = [];
      const headers: Record<string, string> = {};
      const closeHandlers: Array<() => void> = [];

      const res: MockResponse = {
        writableEnded: false,
        socket: { setNoDelay: jest.fn() },
        chunks,
        headers,
        statusCode: undefined,
        jsonBody: undefined,
        on: jest.fn((event: string, handler: () => void) => {
          if (event === 'close') {
            closeHandlers.push(handler);
          }
          return res;
        }),
        status: jest.fn((code: number) => {
          res.statusCode = code;
          return res;
        }),
        setHeader: jest.fn((key: string, value: string) => {
          headers[key] = value;
          return res;
        }),
        flushHeaders: jest.fn(),
        write: jest.fn((chunk: string) => {
          chunks.push(chunk);
          return true;
        }),
        end: jest.fn(() => {
          res.writableEnded = true;
          return res;
        }),
        json: jest.fn((body: unknown) => {
          res.jsonBody = body;
          return res;
        }),
        emitClose: () => closeHandlers.forEach((handler) => handler()),
      };

      return res;
    }

    function parseNdjson(chunks: string[]): unknown[] {
      return chunks
        .join('')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
    }

    it('streams result batches as NDJSON and terminates with a done line', async () => {
      const match = {
        path: 'src/app.ts',
        lineNumber: 2,
        lineText: 'const needle = true;',
        ranges: [{ start: 6, end: 12 }],
      };
      service.searchTextStream = jest.fn(
        async (
          _worktreePath: string,
          _options: unknown,
          onResults: (batch: unknown[]) => void,
        ) => {
          onResults([match]);
          onResults([match]);
          return { limitHit: true };
        },
      ) as unknown as typeof service.searchTextStream;

      const res = createMockResponse();
      await controller.streamSearchText(
        res as never,
        encodeURIComponent('/tmp/worktree'),
        'needle',
      );

      expect(res.headers['Content-Type']).toBe(
        'application/x-ndjson; charset=utf-8',
      );
      expect(res.headers['X-Accel-Buffering']).toBe('no');
      expect(parseNdjson(res.chunks)).toEqual([
        { type: 'results', results: [match] },
        { type: 'results', results: [match] },
        { type: 'done', limitHit: true },
      ]);
      expect(res.end).toHaveBeenCalled();
    });

    it('aborts the search when the client disconnects', async () => {
      let observedSignal: AbortSignal | undefined;
      service.searchTextStream = jest.fn(
        async (
          _worktreePath: string,
          _options: unknown,
          _onResults: unknown,
          signal?: AbortSignal,
        ) => {
          observedSignal = signal;
          return { limitHit: false };
        },
      ) as unknown as typeof service.searchTextStream;

      const res = createMockResponse();
      await controller.streamSearchText(
        res as never,
        encodeURIComponent('/tmp/worktree'),
        'needle',
      );

      expect(observedSignal?.aborted).toBe(false);
      res.emitClose();
      expect(observedSignal?.aborted).toBe(true);
    });

    it('fails with an HTTP status when the search rejects before streaming', async () => {
      service.searchTextStream = jest
        .fn()
        .mockRejectedValue(
          new BadRequestException('Directory does not exist: /nope'),
        ) as unknown as typeof service.searchTextStream;

      const res = createMockResponse();
      await controller.streamSearchText(
        res as never,
        encodeURIComponent('/nope'),
        'needle',
      );

      expect(res.statusCode).toBe(400);
      expect(res.jsonBody).toEqual({
        statusCode: 400,
        message: 'Directory does not exist: /nope',
      });
      expect(res.chunks).toHaveLength(0);
    });

    it('reports a mid-stream failure in band once headers are sent', async () => {
      service.searchTextStream = jest.fn(
        async (
          _worktreePath: string,
          _options: unknown,
          onResults: (batch: unknown[]) => void,
        ) => {
          onResults([]);
          throw new Error('ripgrep exploded');
        },
      ) as unknown as typeof service.searchTextStream;

      const res = createMockResponse();
      await controller.streamSearchText(
        res as never,
        encodeURIComponent('/tmp/worktree'),
        'needle',
      );

      expect(parseNdjson(res.chunks)).toEqual([
        { type: 'results', results: [] },
        { type: 'error', message: 'ripgrep exploded' },
      ]);
      expect(res.end).toHaveBeenCalled();
    });
  });

  describe('rename', () => {
    it('passes decoded old path, new path, and overwrite flag', async () => {
      const rename = jest.fn().mockResolvedValue(undefined);
      service.rename = rename;

      const result = await controller.rename(
        encodeURIComponent('/tmp/worktree path'),
        encodeURIComponent('old name.ts'),
        {
          newPath: 'renamed/new name.ts',
          overwrite: true,
        },
      );

      expect(result).toEqual({ success: true, path: 'renamed/new name.ts' });
      expect(rename).toHaveBeenCalledWith(
        path.join('/tmp/worktree path', 'old name.ts'),
        path.join('/tmp/worktree path', 'renamed/new name.ts'),
        '/tmp/worktree path',
        true,
      );
    });

    it('bubbles BadRequestException', async () => {
      const rename = jest
        .fn()
        .mockRejectedValue(
          new BadRequestException('Destination already exists'),
        );
      service.rename = rename;

      await expect(
        controller.rename(encodeURIComponent('/tmp/worktree'), 'old.ts', {
          newPath: 'new.ts',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('deleteEntry', () => {
    it('passes recursive boolean to service', async () => {
      const deleteEntry = jest.fn().mockResolvedValue(undefined);
      service.deleteEntry = deleteEntry;

      const result = await controller.deleteEntry(
        encodeURIComponent('/tmp/worktree path'),
        encodeURIComponent('folder/file.ts'),
        'true',
      );

      expect(result).toEqual({ success: true });
      expect(deleteEntry).toHaveBeenCalledWith(
        path.join('/tmp/worktree path', 'folder/file.ts'),
        '/tmp/worktree path',
        true,
      );
    });

    it('defaults recursive to false', async () => {
      const deleteEntry = jest.fn().mockResolvedValue(undefined);
      service.deleteEntry = deleteEntry;

      await controller.deleteEntry(
        encodeURIComponent('/tmp/worktree'),
        'file.ts',
      );

      expect(deleteEntry).toHaveBeenCalledWith(
        path.join('/tmp/worktree', 'file.ts'),
        '/tmp/worktree',
        false,
      );
    });

    it('bubbles BadRequestException', async () => {
      const deleteEntry = jest
        .fn()
        .mockRejectedValue(new BadRequestException('Path does not exist'));
      service.deleteEntry = deleteEntry;

      await expect(
        controller.deleteEntry(
          encodeURIComponent('/tmp/worktree'),
          'missing.ts',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
