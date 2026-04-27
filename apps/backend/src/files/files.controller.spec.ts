import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as path from 'node:path';
import { FilesController, FilesystemController } from './files.controller.js';
import { FilesService } from './files.service.js';

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
    filesystemController = module.get<FilesystemController>(FilesystemController);
    service = module.get<FilesService>(FilesService);
  });

  describe('createDirectory', () => {
    it('delegates path suggestions to the service', async () => {
      const suggestPaths = jest.fn().mockResolvedValue([{ path: '/tmp/repo', name: 'repo', kind: 'directory' }]);
      service.suggestPaths = suggestPaths as unknown as FilesService['suggestPaths'];

      const result = await filesystemController.suggestPaths({
        input: '/tmp/re',
        targetKind: 'directory',
        preferredStartDirectory: '/tmp',
      });

      expect(result).toEqual([{ path: '/tmp/repo', name: 'repo', kind: 'directory' }]);
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
        .mockRejectedValue(new BadRequestException('Destination already exists'));
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

      await controller.deleteEntry(encodeURIComponent('/tmp/worktree'), 'file.ts');

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
        controller.deleteEntry(encodeURIComponent('/tmp/worktree'), 'missing.ts'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
