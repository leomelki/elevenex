import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile, execFileSync, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  GitService,
  isValidGitRef,
  type GitStatusSummary,
} from './git.service.js';
import type { SimpleGit, StatusResult } from 'simple-git';
import { clearWorktreeFingerprintCache } from './git-worktree-fingerprint.js';
import { BadRequestException } from '@nestjs/common';
import { TextAgentGenerationService } from '../agent-generation/text-agent-generation.service.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('GitService', () => {
  let service: GitService;
  let tmpDir: string;
  let repoPath: string;

  function createTrackedWorktree(name: string): string {
    const relativePath = `.worktrees/${name}`;
    const worktreePath = path.join(repoPath, relativePath);
    execFileSync('git', ['worktree', 'add', '-b', name, worktreePath], {
      cwd: repoPath,
      stdio: 'pipe',
    });
    execFileSync('git', ['add', '--', relativePath], {
      cwd: repoPath,
      stdio: 'pipe',
    });
    execFileSync('git', ['commit', '-m', 'Track nested worktree'], {
      cwd: repoPath,
      stdio: 'pipe',
    });
    return worktreePath;
  }

  function createMergeConflict(): void {
    const baseBranch = execSync('git branch --show-current', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();

    execSync('git checkout -b incoming', { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, 'initial.txt'), 'incoming content');
    execSync('git add initial.txt', { cwd: repoPath });
    execSync('git commit -m "incoming change"', { cwd: repoPath });

    execSync(`git checkout ${baseBranch}`, { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, 'initial.txt'), 'current content');
    execSync('git add initial.txt', { cwd: repoPath });
    execSync('git commit -m "current change"', { cwd: repoPath });

    try {
      execSync('git merge incoming', { cwd: repoPath, stdio: 'pipe' });
    } catch {
      // Expected: both branches changed initial.txt.
    }
  }

  function getBadRequestMessage(error: unknown): unknown {
    expect(error).toBeInstanceOf(BadRequestException);
    const response = (error as BadRequestException).getResponse();
    return typeof response === 'string'
      ? response
      : (response as { message?: unknown }).message;
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GitService,
        {
          provide: TextAgentGenerationService,
          useValue: { generate: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<GitService>(GitService);

    // Create temp directory
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-test-'));
    repoPath = path.join(tmpDir, 'test-repo');

    // Initialize a git repo
    fs.mkdirSync(repoPath);
    execSync('git init', { cwd: repoPath });
    execSync('git config user.email "test@test.com"', { cwd: repoPath });
    execSync('git config user.name "Test User"', { cwd: repoPath });

    // Create initial commit
    fs.writeFileSync(path.join(repoPath, 'initial.txt'), 'initial content');
    execSync('git add .', { cwd: repoPath });
    execSync('git commit -m "initial commit"', { cwd: repoPath });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getStatus', () => {
    it('should return empty array when no changes', async () => {
      const status = await service.getStatus(repoPath);
      expect(status).toEqual([]);
    });

    it('should detect modified files', async () => {
      fs.writeFileSync(path.join(repoPath, 'initial.txt'), 'modified content');

      const status = await service.getStatus(repoPath);

      expect(status).toHaveLength(1);
      expect(status[0].path).toBe('initial.txt');
      expect(status[0].status).toBe('modified');
      expect(status[0].staged).toBe(false);
    });

    it('should detect untracked files', async () => {
      fs.writeFileSync(path.join(repoPath, 'new-file.txt'), 'new content');

      const status = await service.getStatus(repoPath);

      expect(status).toHaveLength(1);
      expect(status[0].path).toBe('new-file.txt');
      expect(status[0].status).toBe('untracked');
      expect(status[0].staged).toBe(false);
    });

    it('should detect staged files', async () => {
      fs.writeFileSync(path.join(repoPath, 'new-file.txt'), 'new content');
      execSync('git add new-file.txt', { cwd: repoPath });

      const status = await service.getStatus(repoPath);

      expect(status).toHaveLength(1);
      expect(status[0].path).toBe('new-file.txt');
      expect(status[0].status).toBe('added');
      expect(status[0].staged).toBe(true);
    });

    it('should detect deleted files', async () => {
      fs.unlinkSync(path.join(repoPath, 'initial.txt'));

      const status = await service.getStatus(repoPath);

      expect(status).toHaveLength(1);
      expect(status[0].path).toBe('initial.txt');
      expect(status[0].status).toBe('deleted');
      expect(status[0].staged).toBe(false);
    });

    it('should detect renamed files with oldPath', async () => {
      execSync('git mv initial.txt renamed.txt', { cwd: repoPath });

      const status = await service.getStatus(repoPath);

      expect(status).toHaveLength(1);
      expect(status[0].path).toBe('renamed.txt');
      expect(status[0].status).toBe('renamed');
      expect(status[0].staged).toBe(true);
      expect(status[0].oldPath).toBe('initial.txt');
    });

    it('should distinguish staged vs unstaged modifications', async () => {
      // Modify file and stage it
      fs.writeFileSync(path.join(repoPath, 'initial.txt'), 'staged content');
      execSync('git add initial.txt', { cwd: repoPath });

      // Modify again without staging
      fs.writeFileSync(path.join(repoPath, 'initial.txt'), 'unstaged content');

      const status = await service.getStatus(repoPath);

      // Should have both staged and unstaged versions
      const stagedFile = status.find((f) => f.staged);
      const unstagedFile = status.find((f) => !f.staged);

      expect(stagedFile).toBeDefined();
      expect(stagedFile?.status).toBe('modified');
      expect(unstagedFile).toBeDefined();
      expect(unstagedFile?.status).toBe('modified');
    });

    it('should detect conflicted files', async () => {
      createMergeConflict();

      const status = await service.getStatus(repoPath);

      expect(status).toEqual([
        expect.objectContaining({
          path: 'initial.txt',
          status: 'conflicted',
          staged: false,
        }),
      ]);
    });

    it('should return only conflicted files for conflict-only summaries', async () => {
      createMergeConflict();
      fs.writeFileSync(path.join(repoPath, 'unrelated.txt'), 'unrelated');

      const summary = await service.getStatusSummary(repoPath, {
        conflictsOnly: true,
      });

      expect(summary.files).toEqual([
        expect.objectContaining({
          path: 'initial.txt',
          status: 'conflicted',
          staged: false,
        }),
      ]);
      expect(summary.total.files).toBe(1);
      expect(summary.unstaged.files).toBe(1);
    });
  });

  describe('stageFiles', () => {
    it('should stage untracked files', async () => {
      fs.writeFileSync(path.join(repoPath, 'new-file.txt'), 'new content');

      await service.stageFiles(repoPath, ['new-file.txt']);

      const status = await service.getStatus(repoPath);
      expect(status).toHaveLength(1);
      expect(status[0].staged).toBe(true);
    });

    it('should stage modified files', async () => {
      fs.writeFileSync(path.join(repoPath, 'initial.txt'), 'modified content');

      await service.stageFiles(repoPath, ['initial.txt']);

      const status = await service.getStatus(repoPath);
      expect(status).toEqual([
        { path: 'initial.txt', status: 'modified', staged: true },
      ]);
    });

    it('should stage multiple files', async () => {
      fs.writeFileSync(path.join(repoPath, 'file1.txt'), 'content1');
      fs.writeFileSync(path.join(repoPath, 'file2.txt'), 'content2');

      await service.stageFiles(repoPath, ['file1.txt', 'file2.txt']);

      const status = await service.getStatus(repoPath);
      expect(status).toHaveLength(2);
      expect(status.every((f) => f.staged)).toBe(true);
    });
  });

  describe('unstageFiles', () => {
    it('should unstage staged files', async () => {
      fs.writeFileSync(path.join(repoPath, 'new-file.txt'), 'new content');
      execSync('git add new-file.txt', { cwd: repoPath });

      await service.unstageFiles(repoPath, ['new-file.txt']);

      const status = await service.getStatus(repoPath);
      expect(status).toHaveLength(1);
      expect(status[0].staged).toBe(false);
      expect(status[0].status).toBe('untracked');
    });

    it('should unstage modified files leaving them as modified', async () => {
      fs.writeFileSync(path.join(repoPath, 'initial.txt'), 'modified content');
      execSync('git add initial.txt', { cwd: repoPath });

      await service.unstageFiles(repoPath, ['initial.txt']);

      const status = await service.getStatus(repoPath);
      expect(status).toHaveLength(1);
      expect(status[0].staged).toBe(false);
      expect(status[0].status).toBe('modified');
    });
  });

  describe('commit', () => {
    it('should commit staged changes and return hash', async () => {
      fs.writeFileSync(path.join(repoPath, 'new-file.txt'), 'new content');
      await service.stageFiles(repoPath, ['new-file.txt']);

      const result = await service.commit(repoPath, {
        message: 'Add new file',
        provider: 'claude',
      });

      expect(result.hash).toBeDefined();
      expect(result.hash.length).toBeGreaterThan(0);

      // Status should be empty after commit
      const status = await service.getStatus(repoPath);
      expect(status).toEqual([]);
    });

    it('should create commit with correct message', async () => {
      fs.writeFileSync(path.join(repoPath, 'new-file.txt'), 'new content');
      await service.stageFiles(repoPath, ['new-file.txt']);

      await service.commit(repoPath, {
        message: 'Add new file',
        provider: 'claude',
      });

      const log = await service.getLog(repoPath, 1);
      expect(log[0].message).toBe('Add new file');
    });

    it('should preserve no staged changes validation message', async () => {
      let caught: unknown;

      try {
        await service.commit(repoPath, {
          message: 'Noop',
          provider: 'claude',
        });
      } catch (error) {
        caught = error;
      }

      expect(getBadRequestMessage(caught)).toBe(
        'No staged changes are available to commit.',
      );
    });

    it('should expose the git commit error when git rejects the commit', async () => {
      fs.writeFileSync(path.join(repoPath, 'new-file.txt'), 'new content');
      await service.stageFiles(repoPath, ['new-file.txt']);
      const hookPath = path.join(repoPath, '.git', 'hooks', 'pre-commit');
      fs.writeFileSync(
        hookPath,
        '#!/bin/sh\necho "pre-commit rejected commit" >&2\nexit 1\n',
      );
      fs.chmodSync(hookPath, 0o755);

      let caught: unknown;

      try {
        await service.commit(repoPath, {
          message: 'Add new file',
          provider: 'claude',
        });
      } catch (error) {
        caught = error;
      }

      const message = String(getBadRequestMessage(caught));
      expect(message).toContain('pre-commit rejected commit');
      expect(message).not.toBe('Internal server error');
    });
  });

  describe('suggestCommitMessage', () => {
    it('should query claude with a minimal preprompt, no tools, and repo convention docs', async () => {
      fs.writeFileSync(
        path.join(repoPath, 'AGENTS.md'),
        'Follow the commit convention in COMMIT_CONVENTION.md.',
      );
      fs.writeFileSync(
        path.join(repoPath, 'COMMIT_CONVENTION.md'),
        'Use Conventional Commits.',
      );
      fs.writeFileSync(
        path.join(repoPath, 'feature.ts'),
        'export const value = 1;\n',
      );
      await service.stageFiles(repoPath, ['feature.ts']);

      const generate = (service as any).textAgentGenerationService
        .generate as jest.Mock;
      generate.mockResolvedValue({
        provider: 'claude',
        model: 'haiku',
        text: '{"subject":"feat(git): add feature","body":null}',
      });

      await service.suggestCommitMessage(repoPath, 'claude');

      expect(generate).toHaveBeenCalledTimes(1);
      const request = generate.mock.calls[0][0];
      expect(request.claude.tools).toEqual([]);
      expect(request.claude.settingSources).toEqual([]);
      expect(typeof request.claude.systemPrompt).toBe('string');
      expect(request.claude.systemPrompt.length).toBeLessThan(300);
      expect(request.prompt).toContain('Repository convention docs:');
      expect(request.prompt).toContain('### AGENTS.md');
      expect(request.prompt).toContain(
        'Follow the commit convention in COMMIT_CONVENTION.md.',
      );
      expect(request.prompt).toContain('### COMMIT_CONVENTION.md');
      expect(request.prompt).toContain('Use Conventional Commits.');
      expect(request.prompt).toContain(
        execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
          cwd: repoPath,
          encoding: 'utf8',
        }).trim(),
      );
    });

    it('should reject when the selected provider cannot generate a message', async () => {
      fs.writeFileSync(
        path.join(repoPath, 'feature.ts'),
        'export const value = 1;\n',
      );
      await service.stageFiles(repoPath, ['feature.ts']);
      jest
        .spyOn(service as any, 'generateCommitMessageWithClaude')
        .mockResolvedValue(null);

      await expect(
        service.suggestCommitMessage(repoPath, 'claude'),
      ).rejects.toThrow('Could not generate a commit message with claude.');
    });

    it('should generate commit messages with pi when pi is the selected provider', async () => {
      fs.writeFileSync(
        path.join(repoPath, 'feature.ts'),
        'export const value = 1;\n',
      );
      await service.stageFiles(repoPath, ['feature.ts']);
      jest
        .spyOn(service as any, 'generateCommitMessageWithPi')
        .mockResolvedValue({
          subject: 'feat(git): support pi commit messages',
          body: null,
          confidence: 'medium',
          source: 'pi',
        });

      await expect(
        service.suggestCommitMessage(repoPath, 'pi'),
      ).resolves.toEqual({
        subject: 'feat(git): support pi commit messages',
        body: null,
        confidence: 'medium',
        source: 'pi',
      });
    });

    it('should generate commit messages with codex when codex is the selected provider', async () => {
      fs.writeFileSync(
        path.join(repoPath, 'feature.ts'),
        'export const value = 1;\n',
      );
      await service.stageFiles(repoPath, ['feature.ts']);
      jest
        .spyOn(service as any, 'generateCommitMessageWithCodex')
        .mockResolvedValue({
          subject: 'feat(git): support codex commit messages',
          body: null,
          confidence: 'medium',
          source: 'codex',
        });

      await expect(
        service.suggestCommitMessage(repoPath, 'codex'),
      ).resolves.toEqual({
        subject: 'feat(git): support codex commit messages',
        body: null,
        confidence: 'medium',
        source: 'codex',
      });
    });

    it('should still reject providers without a commit message generator', async () => {
      await expect(
        service.suggestCommitMessage(repoPath, 'unknown-agent'),
      ).rejects.toThrow(
        'Commit message generation is not supported for provider "unknown-agent".',
      );
    });

    it('should reject when there are no staged changes', async () => {
      await expect(
        service.suggestCommitMessage(repoPath, 'claude'),
      ).rejects.toThrow(
        'No staged changes available to generate a commit message.',
      );
    });

    it('should parse strict JSON commit suggestions', () => {
      const suggestion = (service as any).parseCommitSuggestion(
        '{"subject":"fix(git): reject invalid generated commit subjects","body":null}',
      );

      expect(suggestion).toEqual({
        subject: 'fix(git): reject invalid generated commit subjects',
        body: null,
        confidence: 'medium',
        source: 'claude',
      });
    });

    it('should parse JSON commit suggestions surrounded by assistant text', () => {
      const suggestion = (service as any).parseCommitSuggestion(
        'I will inspect the diff first.{"subject":"style(investigator): condense doc comments in codefix package","body":null}',
      );

      expect(suggestion).toEqual({
        subject:
          'style(investigator): condense doc comments in codefix package',
        body: null,
        confidence: 'medium',
        source: 'claude',
      });
    });

    it('should parse a later valid JSON commit suggestion after invalid JSON-like text', () => {
      const suggestion = (service as any).parseCommitSuggestion(
        'Notes: {"subject": "Improve generated commit messages", body: null}\n{"subject":"fix(git): parse generated commit message json","body":"Handle assistant preambles without rejecting the suggestion."}',
      );

      expect(suggestion).toEqual({
        subject: 'fix(git): parse generated commit message json',
        body: 'Handle assistant preambles without rejecting the suggestion.',
        confidence: 'medium',
        source: 'claude',
      });
    });

    it('should reject conversational commit suggestions', () => {
      const suggestion = (service as any).parseCommitSuggestion(
        'Sure, let me work on this. fix(git): improve commit messages',
      );

      expect(suggestion).toBeNull();
    });

    it('should accept commit suggestions with non-conventional subjects', () => {
      const suggestion = (service as any).parseCommitSuggestion(
        '{"subject":"Improve generated commit messages","body":null}',
      );

      expect(suggestion).toEqual({
        subject: 'Improve generated commit messages',
        body: null,
        confidence: 'medium',
        source: 'claude',
      });
    });

    it('should reject commit suggestions with an overlong subject', () => {
      const suggestion = (service as any).parseCommitSuggestion(
        JSON.stringify({ subject: 'a'.repeat(201), body: null }),
      );

      expect(suggestion).toBeNull();
    });

    it('should accept overlong conventional commit subjects', () => {
      const suggestion = (service as any).parseCommitSuggestion(
        '{"subject":"refactor(error-tracking): move manual code fix feature flag check into InlineCodeFix","body":null}',
      );

      expect(suggestion).toEqual({
        subject:
          'refactor(error-tracking): move manual code fix feature flag check into InlineCodeFix',
        body: null,
        confidence: 'medium',
        source: 'claude',
      });
    });
  });

  describe('getStatusSummary', () => {
    it('versions local HEAD, index and same-count worktree edits independently of remote refs', async () => {
      const execute = promisify(execFile);
      const run = (...args: string[]) => execute('git', args, { cwd: repoPath });
      const file = path.join(repoPath, 'initial.txt');
      await fs.promises.writeFile(file, 'first replacement\n');
      const first = await service.getStatusSummary(repoPath);
      expect(first.changesRevision).toMatch(/^[a-f0-9]{64}$/);
      expect((await service.getStatusSummary(repoPath)).changesRevision).toBe(first.changesRevision);
      await fs.promises.writeFile(file, 'other replacement\n');
      const second = await service.getStatusSummary(repoPath);
      expect(second.total).toEqual(first.total);
      expect(second.changesRevision).not.toBe(first.changesRevision);
      await service.stageFiles(repoPath, ['initial.txt']);
      const staged = await service.getStatusSummary(repoPath);
      expect(staged.changesRevision).not.toBe(second.changesRevision);
      await run('commit', '-m', 'Save changes');
      const committed = await service.getStatusSummary(repoPath);
      expect(committed.changesRevision).not.toBe(staged.changesRevision);
      await run('update-ref', 'refs/remotes/origin/other', 'HEAD');
      expect((await service.getStatusSummary(repoPath)).changesRevision).toBe(committed.changesRevision);
    });

    it.each(['stage', 'unstage', 'commit'] as const)(
      'does not reuse a pre-%s summary that is still waiting for remote metadata',
      async (mutation) => {
        fs.writeFileSync(path.join(repoPath, 'initial.txt'), 'changed content');
        if (mutation !== 'stage') {
          execFileSync('git', ['add', 'initial.txt'], { cwd: repoPath });
        }
        const observingRemote = deferred<void>();
        const oldRemote = deferred<null>();
        const probe = jest
          .spyOn(service as any, 'findMatchingRemoteBranch')
          .mockImplementationOnce(() => {
            observingRemote.resolve();
            return oldRemote.promise;
          })
          .mockResolvedValue(null);
        const old = service.getStatusSummary(repoPath);
        try {
          await observingRemote.promise;
          if (mutation === 'stage') {
            await service.stageFiles(repoPath, ['initial.txt']);
          } else if (mutation === 'unstage') {
            await service.unstageFiles(repoPath, ['initial.txt']);
          } else {
            await service.commit(repoPath, { message: 'Save changed content' });
          }
          const current = service.getStatusSummary(repoPath);
          expect(current).not.toBe(old);
          const fresh = await current;
          expect(fresh.staged.files).toBe(mutation === 'stage' ? 1 : 0);
          expect(fresh.unstaged.files).toBe(mutation === 'unstage' ? 1 : 0);
          expect(fresh.hasChanges).toBe(mutation !== 'commit');
        } finally {
          oldRemote.resolve(null);
          await old;
          probe.mockRestore();
        }
      },
    );

    it('shares pending summaries and reuses staged stats when only worktree content changes', async () => {
      fs.writeFileSync(path.join(repoPath, 'notes.txt'), 'note\n');
      const entered = deferred<void>();
      const upstream = deferred<string>();
      const getUpstream = jest
        .spyOn(service as any, 'getUpstream')
        .mockResolvedValue('origin/main')
        .mockImplementationOnce(() => {
          entered.resolve();
          return upstream.promise;
        });
      const numstat = jest.spyOn(service as any, 'readNumstat');
      const untracked = jest.spyOn(service as any, 'readUntrackedFileStats');
      const counts = jest
        .spyOn(service as any, 'getAheadBehind')
        .mockResolvedValue({ ahead: 1, behind: 0 });

      const first = service.getStatusSummary(repoPath);
      await entered.promise;
      const second = service.getStatusSummary(`${repoPath}/.`);
      expect(second).toBe(first);
      upstream.resolve('origin/main');
      const [summary, shared] = await Promise.all([first, second]);
      expect(shared).toBe(summary);
      expect(numstat).toHaveBeenCalledTimes(2);
      expect(untracked).toHaveBeenCalledTimes(1);
      expect(getUpstream).toHaveBeenCalledTimes(1);
      expect(counts).toHaveBeenCalledTimes(1);

      fs.writeFileSync(path.join(repoPath, 'notes.txt'), 'note\nsecond\n');
      const next = await service.getStatusSummary(repoPath);
      expect(next.unstaged.additions).toBe(2);
      expect(numstat).toHaveBeenCalledTimes(3);
      expect(untracked).toHaveBeenCalledTimes(2);
      expect(getUpstream).toHaveBeenCalledTimes(2);
      expect(counts).toHaveBeenCalledTimes(2);
    });

    it.each([true, false])(
      'uses local remote refs without network (tracking=%s)',
      async (tracking) => {
        const branch = execFileSync('git', ['branch', '--show-current'], {
          cwd: repoPath,
          encoding: 'utf8',
        }).trim();
        execFileSync(
          'git',
          ['remote', 'add', 'origin', 'ssh://offline.invalid/repo.git'],
          { cwd: repoPath },
        );
        execFileSync(
          'git',
          ['update-ref', `refs/remotes/origin/${branch}`, 'HEAD'],
          { cwd: repoPath },
        );
        if (tracking) {
          execFileSync(
            'git',
            ['branch', `--set-upstream-to=origin/${branch}`],
            { cwd: repoPath },
          );
        }
        const network = jest.spyOn(service as any, 'readRemoteBranchSha');

        const summary = await service.getStatusSummary(repoPath);

        expect(summary.upstream).toBe(`origin/${branch}`);
        expect(summary.ahead).toBe(0);
        expect(summary.behind).toBe(0);
        expect(network).not.toHaveBeenCalled();
      },
    );

    it('detects a same-named branch through a restricted fetch refspec', async () => {
      const remotePath = path.join(tmpDir, 'remote.git');
      const branch = execFileSync('git', ['branch', '--show-current'], {
        cwd: repoPath,
        encoding: 'utf8',
      }).trim();
      execFileSync('git', ['init', '--bare', remotePath], { stdio: 'pipe' });
      execFileSync('git', ['remote', 'add', 'origin', remotePath], {
        cwd: repoPath,
      });
      execFileSync(
        'git',
        [
          'config',
          'remote.origin.fetch',
          '+refs/heads/other:refs/remotes/origin/other',
        ],
        { cwd: repoPath },
      );
      execFileSync('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], {
        cwd: repoPath,
        stdio: 'pipe',
      });
      const network = jest.spyOn(service as any, 'readRemoteBranchSha');

      const summary = await service.getStatusSummary(repoPath);
      expect(summary).toMatchObject({
        upstream: `origin/${branch}`,
        ahead: 0,
        behind: 0,
      });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'Local commit'], {
        cwd: repoPath,
      });
      const next = await service.getStatusSummary(repoPath);
      expect(next).toMatchObject({
        upstream: `origin/${branch}`,
        ahead: 1,
        behind: 0,
      });
      expect(network).toHaveBeenCalledTimes(1);
    });

    it('does not claim synced when the advertised remote object is missing locally', async () => {
      execFileSync(
        'git',
        ['remote', 'add', 'origin', 'ssh://offline.invalid/repo.git'],
        { cwd: repoPath },
      );
      jest
        .spyOn(service as any, 'readRemoteBranchSha')
        .mockResolvedValue('f'.repeat(40));

      const summary = await service.getStatusSummary(repoPath);
      expect(summary.upstream).toBeNull();
      expect(summary.hasChanges).toBe(false);
    });

    it('returns local changes when a remote is unavailable and backs off retries', async () => {
      execFileSync(
        'git',
        ['remote', 'add', 'origin', path.join(tmpDir, 'missing.git')],
        { cwd: repoPath },
      );
      fs.writeFileSync(path.join(repoPath, 'notes.txt'), 'local content\n');
      const network = jest.spyOn(service as any, 'readRemoteBranchSha');

      const summary = await service.getStatusSummary(repoPath);
      expect(summary.upstream).toBeNull();
      expect(summary.files).toEqual([
        { path: 'notes.txt', status: 'untracked', staged: false },
      ]);
      await service.getStatusSummary(repoPath);
      expect(network).toHaveBeenCalledTimes(1);
    });

    (process.platform === 'win32' ? it.skip : it)(
      'bounds a stalled SSH helper and kills it while preserving local status',
      async () => {
        const helper = path.join(tmpDir, 'slow-ssh.sh');
        const pidFile = path.join(tmpDir, 'ssh.pid');
        fs.writeFileSync(
          helper,
          'printf \'%s\' "$$" > "$1"\n' +
            "while :; do printf 'still waiting\\n' >&2; sleep 0.05; done\n",
        );
        execFileSync(
          'git',
          ['remote', 'add', 'origin', 'ssh://offline.invalid/repo.git'],
          { cwd: repoPath },
        );
        execFileSync(
          'git',
          ['config', 'core.sshCommand', `/bin/sh "${helper}" "${pidFile}"`],
          { cwd: repoPath },
        );
        execFileSync('git', ['config', 'ssh.variant', 'ssh'], {
          cwd: repoPath,
        });
        fs.writeFileSync(path.join(repoPath, 'notes.txt'), 'local content\n');
        const readRemote = (service as any).readRemoteBranchSha.bind(service);
        let networkDuration = 0;
        const network = jest
          .spyOn(service as any, 'readRemoteBranchSha')
          .mockImplementation(async (...args: unknown[]) => {
            const started = Date.now();
            try {
              return await readRemote(...args);
            } finally {
              networkDuration = Date.now() - started;
            }
          });
        try {
          const [summary, shared] = await Promise.all([
            service.getStatusSummary(repoPath),
            service.getStatusSummary(`${repoPath}/.`),
          ]);
          expect(networkDuration).toBeLessThan(4_000);
          expect(shared).toBe(summary);
          expect(summary.upstream).toBeNull();
          expect(summary.total.additions).toBe(1);
          expect(fs.existsSync(pidFile)).toBe(true);
          const pid = Number(fs.readFileSync(pidFile, 'utf8'));
          // Give the OS time to reap the killed helper.
          for (let attempt = 0; attempt < 20; attempt++) {
            try {
              process.kill(pid, 0);
            } catch {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          expect(() => process.kill(pid, 0)).toThrow();
          await service.getStatusSummary(repoPath);
          expect(network).toHaveBeenCalledTimes(1);
        } finally {
          if (fs.existsSync(pidFile)) {
            try {
              process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
            } catch {
              /* Already killed. */
            }
          }
        }
      },
      15_000,
    );

    it('ignores internal changes in tracked worktrees across status, stats, diffs, and fingerprints', async () => {
      const firstWorktree = createTrackedWorktree('first');
      const secondWorktree = createTrackedWorktree('second');
      const before = await service.getStatusSummary(repoPath);

      fs.writeFileSync(path.join(firstWorktree, 'initial.txt'), 'changed\n');
      fs.writeFileSync(path.join(secondWorktree, 'untracked.txt'), 'new\n');
      expect(
        execFileSync(
          'git',
          ['status', '--porcelain', '--ignore-submodules=none'],
          {
            cwd: repoPath,
            encoding: 'utf8',
          },
        ),
      ).toContain(' M .worktrees/first');

      expect(await service.getStatus(repoPath)).toEqual([]);
      clearWorktreeFingerprintCache(repoPath);
      const after = await service.getStatusSummary(repoPath);
      expect(after.hasChanges).toBe(false);
      expect(after.files).toEqual([]);
      expect(after.staged).toEqual({ files: 0, additions: 0, deletions: 0 });
      expect(after.unstaged).toEqual({ files: 0, additions: 0, deletions: 0 });
      expect(after.total).toEqual({ files: 0, additions: 0, deletions: 0 });
      expect(after.worktreeFingerprint).toBe(before.worktreeFingerprint);
      expect(await service.getDiff(repoPath, {})).toBe('');
      expect(await service.getStatus(firstWorktree)).toEqual([
        { path: 'initial.txt', status: 'modified', staged: false },
      ]);
      expect(await service.getStatus(secondWorktree)).toEqual([
        { path: 'untracked.txt', status: 'untracked', staged: false },
      ]);
    });

    it('keeps ordinary parent changes visible alongside dirty tracked worktrees', async () => {
      const worktree = createTrackedWorktree('nested');
      fs.writeFileSync(path.join(worktree, 'initial.txt'), 'nested change\n');
      fs.writeFileSync(path.join(repoPath, 'initial.txt'), 'parent change\n');
      fs.writeFileSync(path.join(repoPath, 'notes.txt'), 'note\n');

      const summary = await service.getStatusSummary(repoPath);

      expect(summary.files).toEqual([
        { path: 'initial.txt', status: 'modified', staged: false },
        { path: 'notes.txt', status: 'untracked', staged: false },
      ]);
      expect(summary.hasChanges).toBe(true);
      expect(summary.total).toEqual({ files: 2, additions: 2, deletions: 1 });
    });

    it('keeps unstaged and staged gitlink commit changes visible even when the worktree is dirty', async () => {
      const worktree = createTrackedWorktree('nested');
      fs.writeFileSync(
        path.join(worktree, 'initial.txt'),
        'committed change\n',
      );
      execFileSync('git', ['commit', '-am', 'Update nested worktree'], {
        cwd: worktree,
        stdio: 'pipe',
      });
      fs.writeFileSync(path.join(worktree, 'initial.txt'), 'still dirty\n');

      const unstaged = await service.getStatusSummary(repoPath);
      expect(unstaged.files).toEqual([
        { path: '.worktrees/nested', status: 'modified', staged: false },
      ]);
      expect(unstaged.unstaged).toEqual({
        files: 1,
        additions: 1,
        deletions: 1,
      });
      expect(await service.getDiff(repoPath, {})).toContain(
        'Subproject commit',
      );

      await service.stageFiles(repoPath, ['.worktrees/nested']);

      const staged = await service.getStatusSummary(repoPath);
      expect(staged.files).toEqual([
        { path: '.worktrees/nested', status: 'modified', staged: true },
      ]);
      expect(staged.staged).toEqual({ files: 1, additions: 1, deletions: 1 });
      expect(staged.unstaged).toEqual({ files: 0, additions: 0, deletions: 0 });
    });

    it('should return staged and unstaged line stats', async () => {
      fs.writeFileSync(path.join(repoPath, 'staged.txt'), 'staged line\n');
      execSync('git add staged.txt', { cwd: repoPath });
      fs.writeFileSync(path.join(repoPath, 'notes.txt'), 'note\nline\n');

      const summary = await service.getStatusSummary(repoPath);

      expect(summary.hasChanges).toBe(true);
      expect(summary.upstream).toBeNull();
      expect(summary.headSha).toMatch(/^[a-f0-9]{40}$/);
      expect(summary.worktreeFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(summary.ahead).toBe(0);
      expect(summary.behind).toBe(0);
      expect(summary.staged.files).toBe(1);
      expect(summary.staged.additions).toBeGreaterThan(0);
      expect(summary.unstaged.files).toBe(1);
      expect(summary.unstaged.additions).toBe(2);
    });

    it('should report ahead commits against upstream', async () => {
      const remotePath = path.join(tmpDir, 'remote.git');
      execSync(`git init --bare "${remotePath}"`);
      execSync(`git remote add origin "${remotePath}"`, { cwd: repoPath });
      execSync('git push -u origin HEAD', { cwd: repoPath });

      fs.writeFileSync(path.join(repoPath, 'local.txt'), 'local content');
      execSync('git add local.txt && git commit -m "Add local file"', {
        cwd: repoPath,
      });

      const summary = await service.getStatusSummary(repoPath);

      expect(summary.hasChanges).toBe(false);
      expect(summary.upstream).toMatch(/^origin\//);
      expect(summary.headSha).toMatch(/^[a-f0-9]{40}$/);
      expect(summary.worktreeFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(summary.ahead).toBe(1);
      expect(summary.behind).toBe(0);
    });

    it('changes the worktree fingerprint when local file content changes', async () => {
      fs.writeFileSync(path.join(repoPath, 'notes.txt'), 'note\nline\n');
      const before = await service.getStatusSummary(repoPath);

      fs.writeFileSync(path.join(repoPath, 'notes.txt'), 'note\nchanged\n');
      const after = await service.getStatusSummary(repoPath);

      expect(before.headSha).toBe(after.headSha);
      expect(before.worktreeFingerprint).not.toBe(after.worktreeFingerprint);
    });
  });

  describe('commit with includeUnstaged', () => {
    it('should stage unstaged files before committing when requested', async () => {
      fs.writeFileSync(path.join(repoPath, 'notes.txt'), 'note\nline\n');

      const result = await service.commit(repoPath, {
        message: 'Add notes',
        includeUnstaged: true,
        provider: 'claude',
      });

      expect(result.hash).toBeTruthy();
      const log = await service.getLog(repoPath, 1);
      expect(log[0].message).toBe('Add notes');
      expect(await service.getStatus(repoPath)).toEqual([]);
    });
  });

  describe('merge conflicts', () => {
    it('should summarize active merge conflicts without failing', async () => {
      createMergeConflict();

      const summary = await service.getStatusSummary(repoPath);

      expect(summary.hasChanges).toBe(true);
      expect(summary.files).toEqual([
        expect.objectContaining({
          path: 'initial.txt',
          status: 'conflicted',
          staged: false,
        }),
      ]);
      expect(summary.total.files).toBe(1);
    });

    it('should remove conflicted status after staging marker-free content', async () => {
      createMergeConflict();
      fs.writeFileSync(
        path.join(repoPath, 'initial.txt'),
        'resolved content\n',
      );

      await service.stageFiles(repoPath, ['initial.txt']);

      const status = await service.getStatus(repoPath);
      expect(status.some((file) => file.status === 'conflicted')).toBe(false);
    });
  });

  describe('getLog', () => {
    it('should return commit history', async () => {
      // Create additional commits
      fs.writeFileSync(path.join(repoPath, 'file1.txt'), 'content1');
      execSync('git add . && git commit -m "Add file1"', { cwd: repoPath });

      fs.writeFileSync(path.join(repoPath, 'file2.txt'), 'content2');
      execSync('git add . && git commit -m "Add file2"', { cwd: repoPath });

      const log = await service.getLog(repoPath);

      expect(log.length).toBeGreaterThanOrEqual(3);
      expect(log[0].message).toBe('Add file2');
      expect(log[1].message).toBe('Add file1');
      expect(log[2].message).toBe('initial commit');
    });

    it('should return commits with correct structure', async () => {
      const log = await service.getLog(repoPath, 1);

      expect(log[0].hash).toBeDefined();
      expect(log[0].shortHash).toBeDefined();
      expect(log[0].shortHash.length).toBe(7);
      expect(log[0].message).toBe('initial commit');
      expect(log[0].author).toBe('Test User');
      expect(log[0].date).toBeDefined();
      expect(log[0].relativeDate).toBeDefined();
    });

    it('should respect maxCount parameter', async () => {
      // Create additional commits
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(path.join(repoPath, `file${i}.txt`), `content${i}`);
        execSync('git add . && git commit -m "Add file${i}"', {
          cwd: repoPath,
        });
      }

      const log = await service.getLog(repoPath, 3);
      expect(log.length).toBe(3);
    });
  });

  describe('getDiff', () => {
    it('should return diff for staged changes', async () => {
      fs.writeFileSync(
        path.join(repoPath, 'initial.txt'),
        'modified content\nnew line',
      );
      await service.stageFiles(repoPath, ['initial.txt']);

      const diff = await service.getDiff(repoPath, { staged: true });

      expect(diff).toContain('modified content');
      expect(diff).toContain('new line');
    });

    it('should return diff for unstaged changes', async () => {
      fs.writeFileSync(path.join(repoPath, 'initial.txt'), 'unstaged content');

      const diff = await service.getDiff(repoPath, { staged: false });

      expect(diff).toContain('unstaged content');
    });

    it('should return diff for specific commit', async () => {
      // Create a commit
      fs.writeFileSync(path.join(repoPath, 'new-file.txt'), 'new content');
      execSync('git add . && git commit -m "Add new file"', { cwd: repoPath });

      // Get the commit hash
      const log = await service.getLog(repoPath, 1);
      const commitHash = log[0].hash;

      const diff = await service.getDiff(repoPath, { commit: commitHash });

      expect(diff).toContain('new-file.txt');
      expect(diff).toContain('new content');
    });

    it('should return diff for specific file', async () => {
      // Modify a tracked file
      fs.writeFileSync(
        path.join(repoPath, 'initial.txt'),
        'modified content\nnew line',
      );

      const diff = await service.getDiff(repoPath, { file: 'initial.txt' });

      expect(diff).toContain('initial.txt');
      expect(diff).toContain('modified content');
    });
  });

  describe('push', () => {
    it('should report missing remote gracefully', async () => {
      const result = await service.push(repoPath);

      expect(result.pushed).toBe(false);
      expect(result.message).toContain('No git remote is configured');
    });

    it('rejects detached HEAD without enumerating branches', async () => {
      execFileSync('git', ['checkout', '--detach'], {
        cwd: repoPath,
        stdio: 'pipe',
      });
      await expect(service.push(repoPath)).rejects.toThrow(
        'Cannot push from detached HEAD.',
      );
      const summary = await service.getStatusSummary(repoPath, {
        conflictsOnly: true,
      });
      expect(summary.branch).toBe('HEAD');
    });

    it('reads the current branch in an unborn repository', async () => {
      const unborn = path.join(tmpDir, 'unborn');
      fs.mkdirSync(unborn);
      execFileSync('git', ['init', '-b', 'new-branch'], {
        cwd: unborn,
        stdio: 'pipe',
      });
      const summary = await service.getStatusSummary(unborn, {
        conflictsOnly: true,
      });
      expect(summary.branch).toBe('new-branch');
      expect(summary.headSha).toBeNull();
      expect(await service.push(unborn)).toMatchObject({
        branch: 'new-branch',
        pushed: false,
      });
    });
  });
});

describe('GitService pending request coordination', () => {
  let service: GitService;
  const summary = { branch: 'main' } as GitStatusSummary;

  beforeEach(() => {
    service = new GitService({} as TextAgentGenerationService);
  });

  it('separates conflict mode and worktrees and retries failed summaries', async () => {
    const pending = deferred<GitStatusSummary>();
    const load = jest
      .spyOn(service as any, 'loadStatusSummary')
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(summary);
    const first = service.getStatusSummary('/repo');
    const shared = service.getStatusSummary('/repo/.', {
      conflictsOnly: false,
    });
    const conflicts = service.getStatusSummary('/repo', {
      conflictsOnly: true,
    });
    const other = service.getStatusSummary('/other');
    expect(shared).toBe(first);
    expect(conflicts).not.toBe(first);
    expect(other).not.toBe(first);
    expect(load).toHaveBeenCalledTimes(3);
    pending.reject(new Error('read failed'));
    const results = await Promise.allSettled([first, shared, conflicts, other]);
    expect(results.map((result) => result.status)).toEqual([
      'rejected',
      'rejected',
      'fulfilled',
      'fulfilled',
    ]);
    await expect(service.getStatusSummary('/repo')).resolves.toBe(summary);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it.each(['resolve', 'reject'] as const)(
    'keeps a replacement request when an older one %ss',
    async (settle) => {
      const old = deferred<GitStatusSummary>();
      const replacement = deferred<GitStatusSummary>();
      jest
        .spyOn(service as any, 'loadStatusSummary')
        .mockReturnValue(old.promise);
      const request = service.getStatusSummary('/repo');
      const inFlight = (service as any).statusSummaryInFlight as Map<
        string,
        Promise<GitStatusSummary>
      >;
      const key = JSON.stringify([path.resolve('/repo'), false]);
      inFlight.set(key, replacement.promise);
      if (settle === 'resolve') old.resolve(summary);
      else old.reject(new Error('old failure'));
      await Promise.allSettled([request]);
      expect(service.getStatusSummary('/repo')).toBe(replacement.promise);
      replacement.resolve(summary);
    },
  );

  it('coalesces fallback probes across concurrent callers, backs off failures, and retries', async () => {
    const git = {
      getRemotes: jest
        .fn()
        .mockResolvedValue([{ name: 'origin', refs: { fetch: 'url' } }]),
      revparse: jest.fn().mockRejectedValue(new Error('no local remote ref')),
    } as unknown as SimpleGit;
    const pending = deferred<string | null>();
    const probe = jest
      .spyOn(service as any, 'readRemoteBranchSha')
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue('a'.repeat(40));
    const find = (cwd: string) =>
      (service as any).findMatchingRemoteBranch(git, cwd, 'main');
    const first = find('/repo');
    const second = find('/repo/.');
    // Let both callers reach the pending network operation.
    await new Promise((resolve) => setImmediate(resolve));
    expect(probe).toHaveBeenCalledTimes(1);
    pending.reject(new Error('offline'));
    expect(await Promise.all([first, second])).toEqual([null, null]);
    expect((service as any).remoteBranchInFlight.size).toBe(0);
    expect(await find('/repo')).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);

    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_001);
    try {
      expect(await find('/repo')).toEqual({
        ref: 'origin/main',
        sha: 'a'.repeat(40),
      });
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('caps remote cache entries and isolates branches and changed remote URLs', async () => {
    const remotes = [{ name: 'origin', refs: { fetch: 'old-url' } }];
    const git = {
      getRemotes: jest.fn().mockResolvedValue(remotes),
      revparse: jest.fn().mockRejectedValue(new Error('no local remote ref')),
    } as unknown as SimpleGit;
    const probe = jest
      .spyOn(service as any, 'readRemoteBranchSha')
      .mockResolvedValue(null);
    const find = (branch: string) =>
      (service as any).findMatchingRemoteBranch(git, '/repo', branch);
    for (let index = 0; index < 260; index++) await find(`branch-${index}`);
    expect((service as any).remoteBranchShaCache.size).toBe(256);
    expect(probe).toHaveBeenCalledTimes(260);
    await find('branch-259');
    expect(probe).toHaveBeenCalledTimes(260);
    await find('branch-0');
    expect(probe).toHaveBeenCalledTimes(261);
    remotes[0].refs.fetch = 'new-url';
    await find('branch-259');
    expect(probe).toHaveBeenCalledTimes(262);
  });

  it('maps large mixed dirty sets without repeated array membership scans', () => {
    const renamed = Array.from({ length: 2_000 }, (_, index) => ({
      from: `old-${index}`,
      to: `new-${index}`,
    }));
    const created = Array.from(
      { length: 2_000 },
      (_, index) => `added-${index}`,
    );
    const deleted = Array.from(
      { length: 2_000 },
      (_, index) => `deleted-${index}`,
    );
    const status = {
      staged: [
        ...renamed.map((file) => file.to),
        ...created,
        ...deleted,
        'both',
        'index-only',
        'conflict',
      ],
      renamed,
      created,
      deleted: [...deleted, 'unstaged-delete'],
      conflicted: ['conflict'],
      modified: ['both', 'index-only', 'conflict'],
      not_added: ['untracked'],
      files: [{ path: 'index-only', index: 'M', working_dir: ' ' }],
    } as unknown as StatusResult;
    for (const list of [
      status.staged,
      status.created,
      status.deleted,
      status.conflicted,
    ]) {
      jest.spyOn(list, 'includes').mockImplementation(() => {
        throw new Error('repeated membership scan');
      });
    }
    jest.spyOn(status.renamed, 'some').mockImplementation(() => {
      throw new Error('repeated rename scan');
    });
    const files = (service as any).toFileStatuses(status);
    expect(files).toHaveLength(6_006);
    expect(files).toEqual(
      expect.arrayContaining([
        {
          path: 'new-1999',
          oldPath: 'old-1999',
          status: 'renamed',
          staged: true,
        },
        { path: 'added-1999', status: 'added', staged: true },
        { path: 'deleted-1999', status: 'deleted', staged: true },
        { path: 'both', status: 'modified', staged: true },
        { path: 'both', status: 'modified', staged: false },
        { path: 'index-only', status: 'modified', staged: true },
        { path: 'conflict', status: 'conflicted', staged: false },
        { path: 'unstaged-delete', status: 'deleted', staged: false },
        { path: 'untracked', status: 'untracked', staged: false },
      ]),
    );
  });
});

// Unit tests for git ref validation (GIT-INTEG-07)
describe('isValidGitRef', () => {
  it('should accept valid refs', () => {
    expect(isValidGitRef('master')).toBe(true);
    expect(isValidGitRef('develop')).toBe(true);
    expect(isValidGitRef('feature/test')).toBe(true);
    expect(isValidGitRef('release-1.0.0')).toBe(true);
    expect(isValidGitRef('abc123def456')).toBe(true); // commit hash
  });

  it('should reject empty strings', () => {
    expect(isValidGitRef('')).toBe(false);
    expect(isValidGitRef(null as any)).toBe(false);
    expect(isValidGitRef(undefined as any)).toBe(false);
  });

  it('should reject path traversal', () => {
    expect(isValidGitRef('../')).toBe(false);
    expect(isValidGitRef('..')).toBe(false);
    expect(isValidGitRef('feature/../master')).toBe(false);
  });

  it('should reject shell special characters', () => {
    expect(isValidGitRef(';rm -rf /')).toBe(false);
    expect(isValidGitRef('$(malicious)')).toBe(false);
    expect(isValidGitRef('test|cat')).toBe(false);
    expect(isValidGitRef('branch&echo')).toBe(false);
    expect(isValidGitRef('feature$(cmd)')).toBe(false);
  });

  it('should accept refs with dots and slashes', () => {
    expect(isValidGitRef('release-1.0')).toBe(true);
    expect(isValidGitRef('feature/sub-feature')).toBe(true);
    expect(isValidGitRef('v1.2.3')).toBe(true);
  });
});

describe('GitService.getDiff with validation', () => {
  let service: GitService;
  let tmpDir: string;
  let repoPath: string;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GitService,
        {
          provide: TextAgentGenerationService,
          useValue: { generate: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<GitService>(GitService);

    // Create temp directory
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-test-validation-'));
    repoPath = path.join(tmpDir, 'test-repo');

    // Initialize a git repo
    fs.mkdirSync(repoPath);
    execSync('git init', { cwd: repoPath });
    execSync('git config user.email "test@test.com"', { cwd: repoPath });
    execSync('git config user.name "Test User"', { cwd: repoPath });

    // Create initial commit
    fs.writeFileSync(path.join(repoPath, 'initial.txt'), 'initial content');
    execSync('git add .', { cwd: repoPath });
    execSync('git commit -m "initial commit"', { cwd: repoPath });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should reject invalid commit refs', async () => {
    await expect(
      service.getDiff(repoPath, { commit: ';rm -rf /' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject path traversal in commit refs', async () => {
    await expect(
      service.getDiff(repoPath, { commit: '../etc/passwd' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject shell injection in commit refs', async () => {
    await expect(
      service.getDiff(repoPath, { commit: '$(malicious)' }),
    ).rejects.toThrow(BadRequestException);
  });
});

// Tests for GitService.show() method (GIT-INTEG-05)
describe('GitService.show', () => {
  let service: GitService;
  let tmpDir: string;
  let repoPath: string;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GitService,
        {
          provide: TextAgentGenerationService,
          useValue: { generate: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<GitService>(GitService);

    // Create temp directory
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-show-test-'));
    repoPath = path.join(tmpDir, 'test-repo');

    // Initialize a git repo
    fs.mkdirSync(repoPath);
    execSync('git init', { cwd: repoPath });
    execSync('git config user.email "test@test.com"', { cwd: repoPath });
    execSync('git config user.name "Test User"', { cwd: repoPath });

    // Create initial commit
    fs.writeFileSync(path.join(repoPath, 'initial.txt'), 'initial content');
    execSync('git add .', { cwd: repoPath });
    execSync('git commit -m "initial commit"', { cwd: repoPath });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should retrieve file content from HEAD', async () => {
    const content = await service.show(repoPath, 'HEAD', 'initial.txt');
    expect(content).toBe('initial content');
  });

  it('should retrieve file content from named branch (main)', async () => {
    // Rename default branch to main for test
    execSync('git branch -M main', { cwd: repoPath });

    const content = await service.show(repoPath, 'main', 'initial.txt');
    expect(content).toBe('initial content');
  });

  it('should retrieve file content from commit hash', async () => {
    const log = await service.getLog(repoPath, 1);
    const commitHash = log[0].hash;

    const content = await service.show(repoPath, commitHash, 'initial.txt');
    expect(content).toBe('initial content');
  });

  it('should throw BadRequestException for invalid ref (command injection attempt)', async () => {
    await expect(
      service.show(repoPath, ';rm -rf /', 'initial.txt'),
    ).rejects.toThrow(BadRequestException);
  });

  it('should throw error for non-existent file in git history', async () => {
    await expect(
      service.show(repoPath, 'HEAD', 'nonexistent.txt'),
    ).rejects.toThrow();
  });
});
