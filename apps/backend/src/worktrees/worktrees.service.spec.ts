import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { WorktreesService } from './worktrees.service.js';
import { execFileAsync } from '../terminal/async-process.js';

describe('WorktreesService', () => {
  let service: WorktreesService;
  let tmpDir: string;
  let mainRepoPath: string;
  const git = async (...args: string[]) =>
    (await execFileAsync('git', args, { cwd: mainRepoPath })).stdout;

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
    // Pin the initial branch: the suite asserts on "main", which is only the
    // default where init.defaultBranch is configured.
    await git('init');
    await git('symbolic-ref', 'HEAD', 'refs/heads/main');
    await git('config', 'user.email', 'test@test.com');
    await git('config', 'user.name', 'Test User');

    // Create initial commit
    fs.writeFileSync(path.join(mainRepoPath, 'file.txt'), 'initial');
    await git('add', '.');
    await git('commit', '-m', 'initial commit');

    // Create a feature branch
    await git('checkout', '-b', 'feature-branch');
    await git('checkout', 'main');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('listWorktrees', () => {
    (process.env.ELEVENEX_TEST_MODERN_GIT === '1' ? it : it.skip)(
      'preserves newline paths and multiline lock reasons with modern Git',
      async () => {
        const worktreePath = path.join(tmpDir, 'worktree\nwith newline');
        await git('worktree', 'add', worktreePath, 'feature-branch');
        await git(
          'worktree',
          'lock',
          '--reason',
          'first line\nsecond line',
          worktreePath,
        );
        expect(
          (await service.listWorktrees(mainRepoPath)).find(
            (entry) => entry.path === worktreePath,
          ),
        ).toMatchObject({
          branch: 'feature-branch',
          isLocked: true,
          lockReason: 'first line\nsecond line',
        });
      },
    );
    it('omits a manually deleted worktree even while Git retains its registration', async () => {
      const worktreePath = path.join(tmpDir, 'deleted-wt');
      await service.createWorktree(
        mainRepoPath,
        'feature-branch',
        worktreePath,
      );
      await fs.promises.rm(worktreePath, { recursive: true, force: true });
      const registered = await git('worktree', 'list', '--porcelain');
      expect(registered).toContain('deleted-wt');

      const worktrees = await service.listWorktrees(mainRepoPath);

      expect(worktrees).toHaveLength(1);
      expect(worktrees[0].branch).toBe('main');
    });
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
      await git('worktree', 'add', worktreePath, 'feature-branch');

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

      const expectedPath = path.join(
        tmpDir,
        '.worktrees',
        'main-repo',
        'feature-branch',
      );
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

    it('should create a new branch when it does not exist yet (from HEAD)', async () => {
      const result = await service.createWorktree(mainRepoPath, 'brand-new');

      expect(result.branch).toBe('brand-new');
      // The new branch should now exist as a local ref.
      const branches = await git('branch', '--list', 'brand-new');
      expect(branches).toContain('brand-new');
    });

    it('should create a new branch from an explicit start point', async () => {
      // Add a second commit on main so HEAD and the start point differ.
      fs.writeFileSync(path.join(mainRepoPath, 'file.txt'), 'second');
      await git('add', '.');
      await git('commit', '-m', 'second commit');

      const result = await service.createWorktree(
        mainRepoPath,
        'from-feature',
        undefined,
        'feature-branch',
      );

      expect(result.branch).toBe('from-feature');
      // The new branch should point at feature-branch's tip, not main's.
      const featureSha = (await git('rev-parse', 'feature-branch')).trim();
      const newSha = (await git('rev-parse', 'from-feature')).trim();
      expect(newSha).toBe(featureSha);
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
      await git('worktree', 'add', worktreePath, 'feature-branch');

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

  describe('moveWorktree', () => {
    it('should move worktree to a new path', async () => {
      const worktreePath = path.join(tmpDir, 'feature-wt');
      await git('worktree', 'add', worktreePath, 'feature-branch');
      const newPath = path.join(tmpDir, 'renamed-wt');

      await service.moveWorktree(mainRepoPath, worktreePath, newPath);

      expect(fs.existsSync(worktreePath)).toBe(false);
      expect(fs.existsSync(newPath)).toBe(true);
      const worktrees = await service.listWorktrees(mainRepoPath);
      const realNewPath = fs.realpathSync(newPath);
      const moved = worktrees.find((w) => {
        try {
          return fs.realpathSync(w.path) === realNewPath;
        } catch {
          return false;
        }
      });
      expect(moved?.branch).toBe('feature-branch');
    });

    it('should create missing parent directories of the destination', async () => {
      const worktreePath = path.join(tmpDir, 'feature-wt');
      await git('worktree', 'add', worktreePath, 'feature-branch');
      // `git worktree move` alone fails with ENOENT here: unlike
      // `worktree add`, it does not create leading directories.
      const newPath = path.join(tmpDir, '.worktrees', 'main-repo', 'renamed');

      await service.moveWorktree(mainRepoPath, worktreePath, newPath);

      expect(fs.existsSync(newPath)).toBe(true);
      const worktrees = await service.listWorktrees(mainRepoPath);
      expect(worktrees.map((w) => fs.realpathSync(w.path))).toContain(
        fs.realpathSync(newPath),
      );
    });

    it('should throw BadRequestException for non-existent worktree', async () => {
      await expect(
        service.moveWorktree(
          mainRepoPath,
          '/nonexistent/path',
          path.join(tmpDir, 'wherever'),
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
