import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import type { SimpleGit } from 'simple-git';
import { BranchesService } from './branches.service.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
    execSync('git init -b main', { cwd: mainRepoPath });
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
    jest.restoreAllMocks();
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

    it('does not remove an in-flight replacement when an older read completes', async () => {
      const oldRead = deferred<unknown[]>();
      const newRead = deferred<unknown[]>();
      const read = jest
        .spyOn(service as any, 'readBranches')
        .mockReturnValueOnce(oldRead.promise)
        .mockReturnValue(newRead.promise);
      const old = service.getBranches(`${mainRepoPath}/.`);
      service.invalidateCache(`${mainRepoPath}/`);
      const fresh = service.getBranches(
        path.relative(process.cwd(), mainRepoPath),
      );
      oldRead.resolve([{ name: 'old', isRemote: false }]);
      await old;
      const concurrent = service.getBranches(mainRepoPath);
      expect(read).toHaveBeenCalledTimes(2);
      newRead.resolve([{ name: 'fresh', isRemote: false }]);
      expect(await concurrent).toEqual(await fresh);
      expect(await service.getBranches(mainRepoPath)).toEqual(await fresh);
      expect(read).toHaveBeenCalledTimes(2);
    });

    it('retries failed enumerations without retaining them', async () => {
      const read = jest
        .spyOn(service as any, 'readBranches')
        .mockRejectedValueOnce(new Error('failed read'))
        .mockResolvedValue([]);
      await expect(service.getBranches(mainRepoPath)).rejects.toThrow(
        'failed read',
      );
      expect(await service.getBranches(mainRepoPath)).toEqual([]);
      expect(read).toHaveBeenCalledTimes(2);
    });

    it('bounds retained listings while keeping active enumerations coalesced', async () => {
      const pending = deferred<unknown[]>();
      const read = jest
        .spyOn(service as any, 'readBranches')
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue([]);
      const active = service.getBranches('/tmp/active');
      for (let i = 0; i <= 1_000; i++)
        await service.getBranches(`/tmp/repo-${i}`);
      const concurrent = service.getBranches('/tmp/active');
      await service.getBranches('/tmp/repo-1000');
      expect(read).toHaveBeenCalledTimes(1_002);
      await service.getBranches('/tmp/repo-0');
      expect(read).toHaveBeenCalledTimes(1_003);
      pending.resolve([]);
      expect(await concurrent).toEqual(await active);
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

    it('lists remote-tracking refs without symbolic aliases or misclassifying local names', async () => {
      const git = (command: string) => execSync(command, { cwd: mainRepoPath });
      git('git update-ref refs/remotes/origin/main HEAD');
      git('git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main');
      git('git branch remotes/lookalike');

      const branches = await service.getBranches(mainRepoPath, true);

      expect(branches.filter((b) => b.isRemote).map((b) => b.name)).toEqual([
        'origin/main',
      ]);
      expect(branches.find((b) => b.name === 'remotes/lookalike')).toEqual(
        expect.objectContaining({ isRemote: false, current: false }),
      );
    });

    it('answers pickers from a recent listing while refreshing it in the background', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      const read = jest
        .spyOn(service as any, 'readBranches')
        .mockResolvedValueOnce([{ name: 'old', isRemote: false }])
        .mockResolvedValue([{ name: 'new', isRemote: false }]);
      await service.getBranches(mainRepoPath);
      now.mockReturnValue(1_010_000);

      const stale = await service.getBranches(mainRepoPath, false, {
        allowStale: true,
      });

      expect(stale.map((b) => b.name)).toEqual(['old']);
      expect(read).toHaveBeenCalledTimes(2);
      await Promise.resolve();
      expect(
        (await service.getBranches(mainRepoPath)).map((b) => b.name),
      ).toEqual(['new']);
      expect(read).toHaveBeenCalledTimes(2);
      now.mockReturnValue(1_200_000);
      await service.getBranches(mainRepoPath, false, { allowStale: true });
      expect(read).toHaveBeenCalledTimes(3);
      now.mockRestore();
    });
  });

  describe('search', () => {
    const remote = (name: string) => ({
      name,
      commit: 'abc',
      label: name,
      current: false,
      isRemote: true,
      hasWorktree: false,
      worktreePath: null,
    });

    it('skips enumeration for disallowed short queries, including invalid repositories', async () => {
      const getBranches = jest.spyOn(service, 'getBranches');
      for (const query of ['', '  ', 'a', ' ab ']) {
        expect(
          await service.searchBranches('/nonexistent/path', query),
        ).toEqual([]);
      }
      expect(getBranches).not.toHaveBeenCalled();
      expect(
        await service.searchBranches(mainRepoPath, ' m ', true),
      ).not.toEqual([]);
      expect(getBranches).toHaveBeenCalledTimes(1);
    });

    it('ranks exact and prefix matches above names that merely contain the query', async () => {
      jest
        .spyOn(service as any, 'readBranches')
        .mockResolvedValue(
          [
            'origin/aaron/domain-fix',
            'origin/main-backport',
            'origin/jo/main',
            'origin/main',
            'origin/remain',
          ].map(remote),
        );

      const results = await service.searchRemoteBranches(
        mainRepoPath,
        ' Main ',
      );

      expect(results.map((b) => b.name)).toEqual([
        'origin/main',
        'origin/main-backport',
        'origin/jo/main',
        'origin/remain',
        'origin/aaron/domain-fix',
      ]);
    });

    it('caps results and puts the checked-out branch first for an empty query', async () => {
      jest.spyOn(service as any, 'readBranches').mockResolvedValue([
        ...Array.from({ length: 150 }, (_, i) => ({
          ...remote(`feature-${i}`),
          isRemote: false,
        })),
        { ...remote('zz-current'), isRemote: false, current: true },
      ]);

      const results = await service.searchBranches(mainRepoPath, '', true);

      expect(results).toHaveLength(100);
      expect(results[0].name).toBe('zz-current');
    });
  });

  describe('createBranch', () => {
    it('creates a branch and rejects a duplicate', async () => {
      const created = await service.createBranch(
        mainRepoPath,
        'review',
        'main',
      );
      expect(created).toEqual(expect.objectContaining({ name: 'review' }));
      await expect(
        service.createBranch(mainRepoPath, 'review', 'main'),
      ).rejects.toThrow('already exists');
    });

    it('invalidates listings populated while branch validation is pending', async () => {
      const validating = deferred<void>();
      const releaseValidation = deferred<void>();
      const internal = service as unknown as {
        validateBranchName(git: SimpleGit, name: string): Promise<boolean>;
      };
      const validate = internal.validateBranchName.bind(service);
      jest
        .spyOn(internal, 'validateBranchName')
        .mockImplementation(async (git, name) => {
          validating.resolve();
          await releaseValidation.promise;
          return validate(git, name);
        });
      const creation = service.createBranch(
        mainRepoPath,
        'concurrent/review',
        'main',
      );
      await validating.promise;
      const duringValidation = await service.getBranches(mainRepoPath);
      expect(
        duringValidation.some((branch) => branch.name === 'concurrent/review'),
      ).toBe(false);
      releaseValidation.resolve();

      expect(await creation).toEqual(
        expect.objectContaining({ name: 'concurrent/review' }),
      );
      expect(
        (await service.getBranches(mainRepoPath)).map((branch) => branch.name),
      ).toContain('concurrent/review');
    });

    it('discards a pre-mutation enumeration that finishes after branch creation', async () => {
      const validating = deferred<void>();
      const releaseValidation = deferred<void>();
      const internal = service as unknown as {
        validateBranchName(git: SimpleGit, name: string): Promise<boolean>;
        readBranches(repoPath: string): Promise<unknown[]>;
      };
      const validate = internal.validateBranchName.bind(service);
      const enumerate = internal.readBranches.bind(service);
      jest
        .spyOn(internal, 'validateBranchName')
        .mockImplementation(async (git, name) => {
          validating.resolve();
          await releaseValidation.promise;
          return validate(git, name);
        });
      const stale = deferred<unknown[]>();
      jest.spyOn(internal, 'readBranches').mockReturnValueOnce(stale.promise);
      const creation = service.createBranch(mainRepoPath, 'concurrent/fresh');
      await validating.promise;
      const oldData = await enumerate(mainRepoPath);
      const old = service.getBranches(mainRepoPath);
      releaseValidation.resolve();
      expect(await creation).toEqual(
        expect.objectContaining({ name: 'concurrent/fresh' }),
      );
      stale.resolve(oldData);
      await old;

      expect(
        (await service.getBranches(mainRepoPath)).map((branch) => branch.name),
      ).toContain('concurrent/fresh');
    });

    it('creates literal nested and Unicode branch names from a revision expression', async () => {
      const expectedCommit = execFileSync(
        'git',
        ['rev-parse', 'feature-branch~1'],
        { cwd: mainRepoPath, encoding: 'utf8' },
      ).trim();
      for (const name of [
        'review/nested.topic',
        'fix/Ünicode+topic',
        'review/-nested',
      ]) {
        expect(
          await service.createBranch(mainRepoPath, name, 'feature-branch~1'),
        ).toEqual(expect.objectContaining({ name, commit: expectedCommit }));
        expect(
          execFileSync('git', ['rev-parse', '--verify', `refs/heads/${name}`], {
            cwd: mainRepoPath,
            encoding: 'utf8',
          }).trim(),
        ).toBe(expectedCommit);
      }
    });

    it('rejects invalid literal branch names using Git ref rules', async () => {
      for (const name of [
        '',
        '-option',
        '--help',
        '.hidden',
        'space name',
        'bad~name',
        'bad^name',
        'bad:name',
        'bad?name',
        'bad*name',
        'bad[name',
        'bad\\name',
        'two..dots',
        'trailing/',
        'double//slash',
        'trailing.',
        'nested/.hidden',
        'nested.lock/topic',
        'trailing.lock',
        'has@{reflog',
        'control\u0001name',
        'HEAD',
        '@{-1}',
      ]) {
        await expect(service.createBranch(mainRepoPath, name)).rejects.toThrow(
          'Invalid branch name:',
        );
      }
      expect(
        (await service.getBranches(mainRepoPath)).map((branch) => branch.name),
      ).toEqual(['feature-branch', 'main']);
    });

    it('rejects missing and leading-option start points without modifying refs', async () => {
      for (const startPoint of [
        'missing-ref',
        '--help',
        '--all',
        '--verify',
        '--end-of-options',
        '-main',
      ]) {
        await expect(
          service.createBranch(mainRepoPath, 'must-not-exist', startPoint),
        ).rejects.toThrow('Invalid start point:');
      }
      expect(
        (await service.getBranches(mainRepoPath)).map((branch) => branch.name),
      ).toEqual(['feature-branch', 'main']);
    });
  });
});
