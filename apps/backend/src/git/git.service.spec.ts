import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { GitService, isValidGitRef } from './git.service.js';
import { BadRequestException } from '@nestjs/common';
import { TextAgentGenerationService } from '../agent-generation/text-agent-generation.service.js';

describe('GitService', () => {
  let service: GitService;
  let tmpDir: string;
  let repoPath: string;

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
      // After staging, the file should appear as staged
      // It may also appear as unstaged if simple-git still reports it in modified
      const stagedFile = status.find((f) => f.staged);
      expect(stagedFile).toBeDefined();
      expect(stagedFile?.path).toBe('initial.txt');
      expect(stagedFile?.status).toBe('modified');
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
        service.suggestCommitMessage(repoPath, 'opencode'),
      ).rejects.toThrow(
        'Commit message generation is not supported for provider "opencode".',
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
