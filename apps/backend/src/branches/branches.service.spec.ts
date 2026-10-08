import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { BranchesService } from './branches.service.js';

describe('BranchesService', () => {
  let service: BranchesService;
  let tmpDir: string;
  let mainRepoPath: string;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BranchesService],
    }).compile();

    service = module.get<BranchesService>(BranchesService);

    // Create temp directory
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branches-test-'));
    mainRepoPath = path.join(tmpDir, 'main-repo');

    // Initialize a git repo with multiple branches
    fs.mkdirSync(mainRepoPath);
    execSync('git init', { cwd: mainRepoPath });
    execSync('git config user.email "test@test.com"', { cwd: mainRepoPath });
    execSync('git config user.name "Test User"', { cwd: mainRepoPath });

    // Create initial commit on main
    fs.writeFileSync(path.join(mainRepoPath, 'file.txt'), 'initial');
    execSync('git add .', { cwd: mainRepoPath });
    execSync('git commit -m "initial commit"', { cwd: mainRepoPath });

    // Create a feature branch
    execSync('git checkout -b feature-branch', { cwd: mainRepoPath });
    fs.writeFileSync(path.join(mainRepoPath, 'feature.txt'), 'feature');
    execSync('git add .', { cwd: mainRepoPath });
    execSync('git commit -m "feature commit"', { cwd: mainRepoPath });

    // Go back to main
    execSync('git checkout main', { cwd: mainRepoPath });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getBranches', () => {
    it('coalesces simultaneous local and remote searches into one enumeration', async () => {
      const read = jest.spyOn(service as any, 'readBranches');
      const [local, all] = await Promise.all([
        service.getBranches(mainRepoPath),
        service.getBranches(mainRepoPath, true),
      ]);
      expect(read).toHaveBeenCalledTimes(1);
      expect(local.every((branch) => !branch.isRemote)).toBe(true);
      expect(all).toEqual(local);
    });

    it('does not repopulate an invalidated cache from an older read', async () => {
      let resolveOld!: (value: unknown[]) => void;
      const fresh = [{ name: 'fresh', isRemote: false }];
      const read = jest
        .spyOn(service as any, 'readBranches')
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveOld = resolve;
            }),
        )
        .mockResolvedValue(fresh);
      const old = service.getBranches(mainRepoPath);
      service.invalidateCache(mainRepoPath);
      expect(await service.getBranches(mainRepoPath)).toEqual(fresh);
      resolveOld([{ name: 'old', isRemote: false }]);
      await old;
      expect(await service.getBranches(mainRepoPath)).toEqual(fresh);
      expect(read).toHaveBeenCalledTimes(2);
    });
    it('should return local branches with correct info', async () => {
      const branches = await service.getBranches(mainRepoPath);

      expect(branches).toHaveLength(2);

      const mainBranch = branches.find((b) => b.name === 'main');
      const featureBranch = branches.find((b) => b.name === 'feature-branch');

      expect(mainBranch).toBeDefined();
      expect(mainBranch?.current).toBe(true);
      expect(mainBranch?.hasWorktree).toBe(false);
      expect(mainBranch?.commit).toBeDefined();

      expect(featureBranch).toBeDefined();
      expect(featureBranch?.current).toBe(false);
      expect(featureBranch?.hasWorktree).toBe(false);
    });

    it('should indicate hasWorktree when a worktree exists for a branch', async () => {
      // Create a worktree for feature-branch
      const worktreePath = path.join(tmpDir, 'feature-worktree');
      execSync(`git worktree add "${worktreePath}" feature-branch`, {
        cwd: mainRepoPath,
      });

      const branches = await service.getBranches(mainRepoPath);

      const featureBranch = branches.find((b) => b.name === 'feature-branch');
      expect(featureBranch?.hasWorktree).toBe(true);
      // Compare using realpath for macOS symlink handling
      const realWorktreePath = fs.realpathSync(worktreePath);
      const realBranchWorktreePath = featureBranch?.worktreePath
        ? fs.realpathSync(featureBranch.worktreePath)
        : null;
      expect(realBranchWorktreePath).toBe(realWorktreePath);

      // Main branch should NOT show hasWorktree (main worktree doesn't count)
      const mainBranch = branches.find((b) => b.name === 'main');
      expect(mainBranch?.hasWorktree).toBe(false);
    });

    it('should throw BadRequestException for invalid path', async () => {
      await expect(service.getBranches('/nonexistent/path')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException for non-git directory', async () => {
      const nonGitDir = path.join(tmpDir, 'not-a-repo');
      fs.mkdirSync(nonGitDir);

      await expect(service.getBranches(nonGitDir)).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
