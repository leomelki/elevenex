import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { WorktreesService } from './worktrees.service.js';

describe('WorktreesService', () => {
  let service: WorktreesService;
  let tmpDir: string;
  let mainRepoPath: string;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [WorktreesService],
    }).compile();

    service = module.get<WorktreesService>(WorktreesService);

    // Create temp directory
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktrees-test-'));
    mainRepoPath = path.join(tmpDir, 'main-repo');

    // Initialize a git repo
    fs.mkdirSync(mainRepoPath);
    execSync('git init', { cwd: mainRepoPath });
    execSync('git config user.email "test@test.com"', { cwd: mainRepoPath });
    execSync('git config user.name "Test User"', { cwd: mainRepoPath });

    // Create initial commit
    fs.writeFileSync(path.join(mainRepoPath, 'file.txt'), 'initial');
    execSync('git add .', { cwd: mainRepoPath });
    execSync('git commit -m "initial commit"', { cwd: mainRepoPath });

    // Create a feature branch
    execSync('git checkout -b feature-branch', { cwd: mainRepoPath });
    execSync('git checkout main', { cwd: mainRepoPath });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('listWorktrees', () => {
    it('should return main worktree info', async () => {
      const worktrees = await service.listWorktrees(mainRepoPath);

      expect(worktrees).toHaveLength(1);
      // Compare using realpath for macOS symlink handling
      const realRepoPath = fs.realpathSync(mainRepoPath);
      const realWorktreePath = fs.realpathSync(worktrees[0].path);
      expect(realWorktreePath).toBe(realRepoPath);
      expect(worktrees[0].branch).toBe('main');
      expect(worktrees[0].isDetached).toBe(false);
      expect(worktrees[0].isBare).toBe(false);
    });

    it('should list additional worktrees', async () => {
      const worktreePath = path.join(tmpDir, 'feature-wt');
      execSync(`git worktree add "${worktreePath}" feature-branch`, {
        cwd: mainRepoPath,
      });

      const worktrees = await service.listWorktrees(mainRepoPath);

      expect(worktrees).toHaveLength(2);
      
      // Compare using realpath for macOS symlink handling
      const realWorktreePath = fs.realpathSync(worktreePath);
      const featureWt = worktrees.find((w) => {
        try {
          return fs.realpathSync(w.path) === realWorktreePath;
        } catch {
          return w.path === worktreePath;
        }
      });
      expect(featureWt).toBeDefined();
      expect(featureWt?.branch).toBe('feature-branch');
    });
  });

  describe('createWorktree', () => {
    it('should create worktree at default path', async () => {
      const result = await service.createWorktree(
        mainRepoPath,
        'feature-branch',
      );

      const expectedPath = path.join(tmpDir, '.worktrees', 'main-repo', 'feature-branch');
      // Compare using realpath for macOS symlink handling
      const realResultPath = fs.realpathSync(result.path);
      const realExpectedPath = fs.realpathSync(expectedPath);
      expect(realResultPath).toBe(realExpectedPath);
      expect(result.branch).toBe('feature-branch');

      // Verify worktree exists
      expect(fs.existsSync(expectedPath)).toBe(true);
    });

    it('should create worktree at custom path', async () => {
      const customPath = path.join(tmpDir, 'custom-location');
      const result = await service.createWorktree(
        mainRepoPath,
        'feature-branch',
        customPath,
      );

      // Compare using realpath for macOS symlink handling
      const realResultPath = fs.realpathSync(result.path);
      const realCustomPath = fs.realpathSync(customPath);
      expect(realResultPath).toBe(realCustomPath);
      expect(fs.existsSync(customPath)).toBe(true);
    });

    it('should throw BadRequestException when branch is already checked out', async () => {
      // Create first worktree
      await service.createWorktree(mainRepoPath, 'feature-branch');

      // Try to create another worktree for the same branch
      await expect(
        service.createWorktree(mainRepoPath, 'feature-branch'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('removeWorktree', () => {
    it('should remove worktree successfully', async () => {
      const worktreePath = path.join(tmpDir, 'feature-wt');
      execSync(`git worktree add "${worktreePath}" feature-branch`, {
        cwd: mainRepoPath,
      });

      // Get realpath before removal (since the path won't exist after)
      const realWorktreePath = fs.realpathSync(worktreePath);

      await service.removeWorktree(mainRepoPath, worktreePath);

      const worktrees = await service.listWorktrees(mainRepoPath);
      // Use realpath comparison - the path no longer exists but we saved it above
      const found = worktrees.find((w) => {
        try {
          return fs.realpathSync(w.path) === realWorktreePath;
        } catch {
          return false;
        }
      });
      expect(found).toBeUndefined();
    });

    it('should throw BadRequestException when trying to remove main worktree', async () => {
      await expect(
        service.removeWorktree(mainRepoPath, mainRepoPath),
      ).rejects.toThrow('Cannot remove the main working tree');
    });

    it('should throw BadRequestException for non-existent worktree', async () => {
      await expect(
        service.removeWorktree(mainRepoPath, '/nonexistent/path'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
