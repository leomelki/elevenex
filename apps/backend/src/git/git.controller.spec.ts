import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { GitController } from './git.controller.js';
import { GitService } from './git.service.js';

describe('GitController', () => {
  let controller: GitController;
  let service: GitService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GitController],
      providers: [
        {
          provide: GitService,
          useValue: {
            show: jest.fn(),
            getStatusSummary: jest.fn(),
            commit: jest.fn(),
            push: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<GitController>(GitController);
    service = module.get<GitService>(GitService);
  });

  describe('getOriginalContent', () => {
    it('should return file content from HEAD', async () => {
      const mockContent = 'initial content';
      const mockShow = jest.fn().mockResolvedValue(mockContent);
      service.show = mockShow;

      const worktreePath = '/test/repo';
      const path = 'initial.txt';

      const result = await controller.getOriginalContent(
        worktreePath,
        path,
        undefined,
      );

      expect(result).toEqual({ content: mockContent });
      expect(mockShow).toHaveBeenCalledWith(worktreePath, 'HEAD', path);
    });

    it('should return file content from named branch', async () => {
      const mockContent = 'branch content';
      const mockShow = jest.fn().mockResolvedValue(mockContent);
      service.show = mockShow;

      const worktreePath = '/test/repo';
      const ref = 'develop';
      const path = 'file.txt';

      const result = await controller.getOriginalContent(
        worktreePath,
        path,
        ref,
      );

      expect(result).toEqual({ content: mockContent });
      expect(mockShow).toHaveBeenCalledWith(worktreePath, ref, path);
    });

    it('should return 400 for invalid ref', async () => {
      const mockShow = jest
        .fn()
        .mockRejectedValue(new BadRequestException('Invalid git ref'));
      service.show = mockShow;

      const worktreePath = '/test/repo';
      const ref = ';rm -rf /';
      const path = 'file.txt';

      await expect(
        controller.getOriginalContent(worktreePath, path, ref),
      ).rejects.toThrow(BadRequestException);
    });

    it('should return 500 for non-existent file', async () => {
      const mockShow = jest.fn().mockRejectedValue(new Error('File not found'));
      service.show = mockShow;

      const worktreePath = '/test/repo';
      const path = 'nonexistent.txt';

      await expect(
        controller.getOriginalContent(worktreePath, path, undefined),
      ).rejects.toThrow('File not found');
    });

    it('should decode URI-encoded worktreePath and path', async () => {
      const mockContent = 'content';
      const mockShow = jest.fn().mockResolvedValue(mockContent);
      service.show = mockShow;

      const encodedWorktreePath = encodeURIComponent('/test/path with spaces');
      const encodedPath = encodeURIComponent('file with spaces.txt');

      const result = await controller.getOriginalContent(
        encodedWorktreePath,
        encodedPath,
        undefined,
      );

      expect(result).toEqual({ content: mockContent });
      expect(mockShow).toHaveBeenCalledWith(
        '/test/path with spaces',
        'HEAD',
        'file with spaces.txt',
      );
    });

    it('should use HEAD as default when ref is undefined', async () => {
      const mockContent = 'content';
      const mockShow = jest.fn().mockResolvedValue(mockContent);
      service.show = mockShow;

      const worktreePath = '/test/repo';
      const path = 'file.txt';

      const result = await controller.getOriginalContent(
        worktreePath,
        path,
        undefined,
      );

      expect(mockShow).toHaveBeenCalledWith(worktreePath, 'HEAD', path);
    });
  });

  describe('getSummary', () => {
    it('should decode the worktree path before loading the summary', async () => {
      const mockSummary = {
        branch: 'main',
        upstream: 'origin/main',
        ahead: 1,
        behind: 0,
        hasChanges: true,
        files: [],
        staged: { files: 1, additions: 2, deletions: 0 },
        unstaged: { files: 0, additions: 0, deletions: 0 },
        total: { files: 1, additions: 2, deletions: 0 },
      };
      const mockGetStatusSummary = jest.fn().mockResolvedValue(mockSummary);
      service.getStatusSummary = mockGetStatusSummary;

      const result = await controller.getSummary(
        encodeURIComponent('/test/path with spaces'),
      );

      expect(result).toEqual(mockSummary);
      expect(mockGetStatusSummary).toHaveBeenCalledWith(
        '/test/path with spaces',
      );
    });
  });

  describe('commit', () => {
    it('should pass message and includeUnstaged to the service', async () => {
      const mockCommit = jest.fn().mockResolvedValue({
        hash: 'abc123',
        message: 'Test commit',
        generatedMessage: false,
      });
      service.commit = mockCommit;

      const result = await controller.commit({
        worktreePath: encodeURIComponent('/test/repo'),
        message: 'Test commit',
        includeUnstaged: true,
        provider: 'claude',
      });

      expect(result.hash).toBe('abc123');
      expect(mockCommit).toHaveBeenCalledWith('/test/repo', {
        message: 'Test commit',
        includeUnstaged: true,
        provider: 'claude',
        requestId: expect.any(String),
      });
    });
  });

  describe('push', () => {
    it('should decode the worktree path before pushing', async () => {
      const mockPush = jest.fn().mockResolvedValue({
        pushed: true,
        remote: 'origin',
        branch: 'feature/test',
        upstream: 'origin/feature/test',
        createdUpstream: true,
        nonFastForward: false,
        rejected: false,
        message: 'Pushed feature/test and set upstream to origin/feature/test.',
      });
      service.push = mockPush;

      const result = await controller.push({
        worktreePath: encodeURIComponent('/test/path with spaces'),
      });

      expect(result.pushed).toBe(true);
      expect(mockPush).toHaveBeenCalledWith('/test/path with spaces');
    });
  });
});
