import { EventEmitter } from 'node:events';
import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { FilesController, FilesystemController } from './files.controller.js';
import { FilesService } from './files.service.js';
import { DRIZZLE } from '../database/database.provider.js';

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
  const taskRow = {
    id: 12,
    path: '/tmp/checkout',
    taskState: 'ready',
    linkStatus: 'linked',
    archivedAt: null as string | null,
  };
  const taskLookup = jest.fn();

  beforeEach(async () => {
    taskLookup.mockResolvedValue([{ ...taskRow }]);
    const module: TestingModule = await Test.createTestingModule({
      controllers: [FilesController, FilesystemController],
      providers: [
        {
          provide: DRIZZLE,
          useValue: {
            select: () => ({
              from: () => ({ where: () => ({ limit: taskLookup }) }),
            }),
          },
        },
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

  it('rejects a stale editor after its task is finished or assigned to a different directory', async () => {
    for (const row of [
      { ...taskRow, archivedAt: '2026-10-08' },
      { ...taskRow, taskState: 'finishing' },
      { ...taskRow, path: '/tmp/another-checkout' },
    ]) {
      taskLookup.mockResolvedValue([row]);
      await expect(
        controller.writeFile(
          '/tmp/checkout',
          'notes.md',
          { content: 'old editor' },
          '12',
        ),
      ).rejects.toThrow('inactive task');
    }
    expect(service.writeFile).not.toHaveBeenCalled();
  });

  it('allows a current task editor to save', async () => {
    await controller.writeFile(
      '/tmp/checkout',
      'notes.md',
      { content: 'findings' },
      '12',
    );
    expect(service.writeFile).toHaveBeenCalledWith(
      '/tmp/checkout/notes.md',
      'findings',
      '/tmp/checkout',
    );
  });

  it('streams external media with decoded query paths, range headers, and disconnect cleanup', async () => {
    const stream = Readable.from(['test']);
    service.readLocalMedia = jest.fn().mockResolvedValue({
      stream,
      mimeType: 'video/mp4',
      statusCode: 206,
      contentRange: 'bytes 2-5/10',
      length: 4,
    });
    const res = { status: jest.fn(), setHeader: jest.fn(), once: jest.fn() };
    const file = await filesystemController.readMedia(
      '/tmp/été #1%,demo.mp4',
      res as never,
      'bytes=2-5',
    );
    expect(service.readLocalMedia).toHaveBeenCalledWith(
      '/tmp/été #1%,demo.mp4',
      'bytes=2-5',
    );
    expect(res.status).toHaveBeenCalledWith(206);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Range', 'bytes 2-5/10');
    expect(file.getStream()).toBe(stream);
    res.once.mock.calls[0][1]();
    expect(stream.destroyed).toBe(true);
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
  });
});
