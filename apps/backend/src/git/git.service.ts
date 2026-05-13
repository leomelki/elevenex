import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { execFile, type ExecFileOptions } from 'node:child_process';
import { SimpleGit, StatusResult, LogResult } from 'simple-git';

import {
  buildAugmentedEnv,
  findBinary,
  worktreeSimpleGit,
} from '../config/system-paths.js';
import type { AgentProviderId } from '../agent-runtime/agent-runtime.types.js';
import { PiSessionRuntime } from '../pi-runtime/pi-session-runtime.js';

const SAFE_REF_PATTERN = /^[a-zA-Z0-9\/_.-]+$/;
const CLAUDE_BIN = findBinary('claude') ?? 'claude';
const DEFAULT_CODEX_MODEL = 'gpt-5.5';
const MAX_COMMIT_MESSAGE_DIFF_CHARS = 24_000;
const MAX_COMMIT_MESSAGE_LOG_ENTRIES = 8;
const MAX_COMMIT_MESSAGE_STATUS_FILES = 16;
const CONVENTIONAL_COMMIT_SUBJECT_PATTERN =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9][a-z0-9._-]*\))?!?: [a-z0-9].*[^.]$/;
type CommitMessageProvider = 'claude' | 'codex' | 'pi';

export function isValidGitRef(ref: string): boolean {
  if (!ref || ref.length === 0) return false;
  if (ref.includes('..')) return false;
  return SAFE_REF_PATTERN.test(ref);
}

type CodexSdkModule = typeof import('@openai/codex-sdk');

const importCodexSdk = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<CodexSdkModule>;

export interface FileStatus {
  path: string;
  status:
    | 'modified'
    | 'added'
    | 'deleted'
    | 'renamed'
    | 'untracked'
    | 'conflicted';
  staged: boolean;
  oldPath?: string;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  relativeDate: string;
}

export interface CommitMessageSuggestion {
  subject: string;
  body: string | null;
  confidence: 'high' | 'medium' | 'low';
  source: 'external' | 'claude' | 'codex' | 'pi' | 'fallback';
}

export interface PushResult {
  pushed: boolean;
  remote: string | null;
  branch: string;
  upstream: string | null;
  createdUpstream: boolean;
  nonFastForward: boolean;
  rejected: boolean;
  message: string;
}

export interface GitScopeSummary {
  files: number;
  additions: number;
  deletions: number;
}

export interface GitStatusSummary {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasChanges: boolean;
  files: FileStatus[];
  staged: GitScopeSummary;
  unstaged: GitScopeSummary;
  total: GitScopeSummary;
}

export interface CommitResult {
  hash: string;
  message: string;
  generatedMessage: boolean;
}

@Injectable()
export class GitService {
  private readonly logger = new Logger(GitService.name);

  async getStatus(worktreePath: string): Promise<FileStatus[]> {
    const git: SimpleGit = worktreeSimpleGit(worktreePath);
    const status: StatusResult = await git.status();

    const files: FileStatus[] = [];

    status.staged.forEach((path) => {
      if (status.renamed.some((r) => r.to === path)) return;
      files.push({
        path,
        status: this.getFileStatus(status, path),
        staged: true,
      });
    });

    status.modified.forEach((path) => {
      files.push({ path, status: 'modified', staged: false });
    });

    status.not_added.forEach((path) => {
      files.push({ path, status: 'untracked', staged: false });
    });

    status.deleted.forEach((path) => {
      files.push({
        path,
        status: 'deleted',
        staged: status.staged.includes(path),
      });
    });

    status.renamed.forEach(({ from, to }) => {
      files.push({ path: to, status: 'renamed', staged: true, oldPath: from });
    });

    return files.sort((left, right) => {
      if (left.staged !== right.staged) return left.staged ? -1 : 1;
      return left.path.localeCompare(right.path);
    });
  }

  async getStatusSummary(worktreePath: string): Promise<GitStatusSummary> {
    const git: SimpleGit = worktreeSimpleGit(worktreePath);
    const [files, status, stagedStats, unstagedStats] = await Promise.all([
      this.getStatus(worktreePath),
      git.status(),
      this.getScopeStats(worktreePath, true),
      this.getScopeStats(worktreePath, false),
    ]);

    const branch = status.current || 'HEAD';
    const upstream = await this.getUpstream(git);
    const { ahead, behind } = upstream
      ? await this.getAheadBehind(git, branch, upstream)
      : { ahead: 0, behind: 0 };

    return {
      branch,
      upstream,
      ahead,
      behind,
      hasChanges: files.length > 0,
      files,
      staged: stagedStats,
      unstaged: unstagedStats,
      total: {
        files: new Set(files.map((file) => file.path)).size,
        additions: stagedStats.additions + unstagedStats.additions,
        deletions: stagedStats.deletions + unstagedStats.deletions,
      },
    };
  }

  async stageFiles(worktreePath: string, files: string[]): Promise<void> {
    const git: SimpleGit = worktreeSimpleGit(worktreePath);
    await git.add(files);
  }

  async unstageFiles(worktreePath: string, files: string[]): Promise<void> {
    const git: SimpleGit = worktreeSimpleGit(worktreePath);
    await git.raw(['reset', 'HEAD', '--', ...files]);
  }

  async commit(
    worktreePath: string,
    options: {
      message?: string;
      includeUnstaged?: boolean;
      provider?: AgentProviderId;
      requestId?: string;
    } = {},
  ): Promise<CommitResult> {
    const requestId = options.requestId ?? this.createRequestId();
    const git: SimpleGit = worktreeSimpleGit(worktreePath);

    this.logger.log(
      `[commit:${requestId}] service started worktreePath="${worktreePath}" includeUnstaged=${Boolean(options.includeUnstaged)}`,
    );

    try {
      if (options.includeUnstaged) {
        this.logger.log(
          `[commit:${requestId}] staging all changes with git add --all`,
        );
        await git.raw(['add', '--all']);
        this.logger.log(`[commit:${requestId}] git add --all completed`);
      }

      const status = await git.status();
      const stagedFiles = this.getUniqueStagedFiles(status);
      this.logger.log(
        `[commit:${requestId}] status loaded branch="${status.current || 'HEAD'}" staged=${stagedFiles.length} modified=${status.modified.length} deleted=${status.deleted.length} renamed=${status.renamed.length} untracked=${status.not_added.length} conflicted=${status.conflicted.length} stagedFiles=${this.previewList(stagedFiles)}`,
      );

      if (stagedFiles.length === 0) {
        this.logger.warn(
          `[commit:${requestId}] aborting: no commit candidates after status check includeUnstaged=${Boolean(options.includeUnstaged)}`,
        );
        throw new BadRequestException(
          options.includeUnstaged
            ? 'No changes are available to commit.'
            : 'No staged changes are available to commit.',
        );
      }

      let message = options.message?.trim() ?? '';
      let generatedMessage = false;

      if (!message) {
        this.logger.log(
          `[commit:${requestId}] no message provided; generating commit message`,
        );
        const suggestion = await this.suggestCommitMessage(
          worktreePath,
          options.provider,
        );
        message = suggestion.body?.trim()
          ? `${suggestion.subject.trim()}\n\n${suggestion.body.trim()}`
          : suggestion.subject.trim();
        generatedMessage = true;
        this.logger.log(
          `[commit:${requestId}] generated commit message source=${suggestion.source} confidence=${suggestion.confidence} subject="${this.preview(suggestion.subject)}"`,
        );
      } else {
        this.logger.log(
          `[commit:${requestId}] using provided commit message chars=${message.length} lines=${this.countLines(message)} subject="${this.preview(message.split(/\r?\n/, 1)[0] ?? '')}"`,
        );
      }

      this.logger.log(`[commit:${requestId}] running git commit`);
      const result = await git.commit(message);
      this.logger.log(
        `[commit:${requestId}] git commit completed hash=${result.commit || 'unknown'} generatedMessage=${generatedMessage}`,
      );
      return {
        hash: result.commit,
        message,
        generatedMessage,
      };
    } catch (error: any) {
      this.logger.error(
        `[commit:${requestId}] failed ${this.formatGitError(error)}`,
        error?.stack,
      );
      throw error;
    }
  }

  async suggestCommitMessage(
    worktreePath: string,
    provider: AgentProviderId | undefined,
  ): Promise<CommitMessageSuggestion> {
    const requestId = this.createRequestId();
    const messageProvider = this.normalizeCommitMessageProvider(provider);
    this.logger.log(
      `[commit-message:${requestId}] suggestion started worktreePath="${worktreePath}" provider=${messageProvider}`,
    );

    const git: SimpleGit = worktreeSimpleGit(worktreePath);
    try {
      const status = await git.status();
      const stagedFiles = this.getUniqueStagedFiles(status);
      this.logger.log(
        `[commit-message:${requestId}] status loaded branch="${status.current || 'HEAD'}" staged=${stagedFiles.length} stagedFiles=${this.previewList(stagedFiles)}`,
      );

      if (stagedFiles.length === 0) {
        this.logger.warn(
          `[commit-message:${requestId}] aborting: no staged files available for suggestion`,
        );
        throw new BadRequestException(
          'No staged changes available to generate a commit message.',
        );
      }

      const [diff, branchSummary, log] = await Promise.all([
        this.getDiff(worktreePath, { staged: true }),
        git.branchLocal(),
        this.getLog(worktreePath, MAX_COMMIT_MESSAGE_LOG_ENTRIES),
      ]);

      const currentBranch = branchSummary.current || 'HEAD';
      const compressedStatus = this.buildCompactStatusSummary(stagedFiles);
      const compressedLog = this.buildCompactLog(log);
      const truncatedDiff = this.truncateDiffForPrompt(diff);
      this.logger.log(
        `[commit-message:${requestId}] context loaded branch="${currentBranch}" diffChars=${diff.length} truncatedDiffChars=${truncatedDiff.length} recentCommits=${log.length}`,
      );

      const promptInput = {
        worktreePath,
        branchName: currentBranch,
        files: stagedFiles,
        diff: truncatedDiff,
        compactStatus: compressedStatus,
        compactLog: compressedLog,
      };

      const aiSuggestion = await this.generateCommitMessageWithProvider(
        messageProvider,
        promptInput,
      );

      if (aiSuggestion) {
        this.logger.log(
          `[commit-message:${requestId}] suggestion completed source=${aiSuggestion.source} confidence=${aiSuggestion.confidence} subject="${this.preview(aiSuggestion.subject)}"`,
        );
        return aiSuggestion;
      }

      throw new BadRequestException(
        `Could not generate a commit message with ${messageProvider}.`,
      );
    } catch (error: any) {
      this.logger.error(
        `[commit-message:${requestId}] failed ${this.formatGitError(error)}`,
        error?.stack,
      );
      throw error;
    }
  }

  async push(worktreePath: string): Promise<PushResult> {
    const requestId = this.createRequestId();
    const git: SimpleGit = worktreeSimpleGit(worktreePath);
    this.logger.log(
      `[push:${requestId}] service started worktreePath="${worktreePath}"`,
    );
    const branchSummary = await git.branchLocal();
    const branch = branchSummary.current;
    this.logger.log(
      `[push:${requestId}] branch loaded branch="${branch || 'HEAD'}"`,
    );

    if (!branch) {
      this.logger.warn(`[push:${requestId}] aborting: detached HEAD`);
      throw new BadRequestException('Cannot push from detached HEAD.');
    }

    let upstream: string | null = null;
    try {
      upstream = (
        await git.raw([
          'rev-parse',
          '--abbrev-ref',
          '--symbolic-full-name',
          '@{u}',
        ])
      ).trim();
      this.logger.log(
        `[push:${requestId}] upstream detected upstream="${upstream}"`,
      );
    } catch {
      upstream = null;
      this.logger.log(`[push:${requestId}] no upstream configured`);
    }

    try {
      if (!upstream) {
        const remotes = await git.getRemotes(true);
        const remote =
          remotes.find((candidate) => candidate.name === 'origin') ??
          remotes[0];
        if (!remote) {
          this.logger.warn(
            `[push:${requestId}] aborting: no git remote configured`,
          );
          throw new BadRequestException(
            'No git remote is configured for this repository.',
          );
        }

        this.logger.log(
          `[push:${requestId}] pushing branch="${branch}" remote="${remote.name}" setUpstream=true`,
        );
        await git.push(remote.name, branch, { '--set-upstream': null });
        this.logger.log(
          `[push:${requestId}] push completed remote="${remote.name}" upstream="${remote.name}/${branch}"`,
        );
        return {
          pushed: true,
          remote: remote.name,
          branch,
          upstream: `${remote.name}/${branch}`,
          createdUpstream: true,
          nonFastForward: false,
          rejected: false,
          message: `Pushed ${branch} and set upstream to ${remote.name}/${branch}.`,
        };
      }

      const [remoteName] = upstream.split('/', 1);
      this.logger.log(
        `[push:${requestId}] pushing branch="${branch}" remote="${remoteName}" upstream="${upstream}"`,
      );
      await git.push(remoteName);
      this.logger.log(
        `[push:${requestId}] push completed remote="${remoteName}" upstream="${upstream}"`,
      );
      return {
        pushed: true,
        remote: remoteName || null,
        branch,
        upstream,
        createdUpstream: false,
        nonFastForward: false,
        rejected: false,
        message: `Pushed ${branch} to ${upstream}.`,
      };
    } catch (error: any) {
      const message = error?.message || 'Git push failed';
      const rejected = /rejected|failed to push/i.test(message);
      const nonFastForward =
        /non-fast-forward|fetch first|tip of your current branch is behind/i.test(
          message,
        );
      this.logger.error(
        `[push:${requestId}] failed rejected=${rejected} nonFastForward=${nonFastForward} ${this.formatGitError(error)}`,
        error?.stack,
      );

      return {
        pushed: false,
        remote: upstream ? upstream.split('/', 1)[0] || null : null,
        branch,
        upstream,
        createdUpstream: false,
        nonFastForward,
        rejected,
        message,
      };
    }
  }

  async getLog(
    worktreePath: string,
    maxCount: number = 50,
  ): Promise<CommitInfo[]> {
    const git: SimpleGit = worktreeSimpleGit(worktreePath);
    const log: LogResult = await git.log({ maxCount });

    return log.all.map((commit) => ({
      hash: commit.hash,
      shortHash: commit.hash.substring(0, 7),
      message: commit.message,
      author: commit.author_name || 'Unknown',
      date: commit.date,
      relativeDate: this.getRelativeDate(commit.date),
    }));
  }

  async getDiff(
    worktreePath: string,
    options: { staged?: boolean; file?: string; commit?: string },
  ): Promise<string> {
    const git: SimpleGit = worktreeSimpleGit(worktreePath);

    if (options.commit) {
      if (!isValidGitRef(options.commit)) {
        throw new BadRequestException(`Invalid git ref: ${options.commit}`);
      }

      return git.raw(['diff-tree', '-p', '--root', options.commit]);
    }

    if (options.staged) {
      const args = ['--cached'];
      if (options.file) args.push(options.file);
      return git.diff(args);
    }

    const args = options.file ? [options.file] : [];
    return git.diff(args);
  }

  async show(worktreePath: string, ref: string, path: string): Promise<string> {
    const git: SimpleGit = worktreeSimpleGit(worktreePath);

    if (!isValidGitRef(ref)) {
      throw new BadRequestException(`Invalid git ref: ${ref}`);
    }

    try {
      const content = await git.show([`${ref}:${path}`]);
      return content;
    } catch (error: any) {
      throw new Error(
        `Failed to retrieve file from git history: ${error.message}`,
      );
    }
  }

  private createRequestId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private countLines(value: string): number {
    return value ? value.split(/\r?\n/).length : 0;
  }

  private preview(value: string, maxLength = 120): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > maxLength
      ? `${normalized.slice(0, maxLength)}...`
      : normalized;
  }

  private previewList(values: string[], maxItems = 12): string {
    if (values.length === 0) {
      return '[]';
    }

    const visible = values.slice(0, maxItems);
    const suffix =
      values.length > visible.length
        ? `, ...+${values.length - visible.length}`
        : '';
    return `[${visible.map((value) => `"${this.preview(value, 80)}"`).join(', ')}${suffix}]`;
  }

  private formatGitError(error: any): string {
    const details = [
      `name=${error?.name || 'Error'}`,
      `message="${this.preview(error?.message || String(error))}"`,
    ];

    if (error?.task?.commands) {
      details.push(`commands=${JSON.stringify(error.task.commands)}`);
    }
    if (error?.git?.command) {
      details.push(`command="${error.git.command}"`);
    }
    if (typeof error?.git?.exitCode !== 'undefined') {
      details.push(`exitCode=${error.git.exitCode}`);
    }
    if (error?.git?.stdErr) {
      details.push(`stderr="${this.preview(error.git.stdErr, 240)}"`);
    }

    return details.join(' ');
  }

  private getUniqueStagedFiles(status: StatusResult): string[] {
    const stagedFiles = [
      ...status.staged,
      ...status.renamed.map((file) => file.to),
    ];
    return Array.from(new Set(stagedFiles)).sort();
  }

  private async getScopeStats(
    worktreePath: string,
    staged: boolean,
  ): Promise<GitScopeSummary> {
    const files = await this.getStatus(worktreePath);
    const scopeFiles = files.filter((file) => file.staged === staged);
    const diffStats = await this.readNumstat(worktreePath, staged);

    let additions = diffStats.additions;
    let deletions = diffStats.deletions;

    if (!staged) {
      const untrackedFiles = scopeFiles.filter(
        (file) => file.status === 'untracked',
      );
      const untrackedStats = await Promise.all(
        untrackedFiles.map((file) =>
          this.readUntrackedFileStats(worktreePath, file.path),
        ),
      );
      additions += untrackedStats.reduce(
        (sum, stat) => sum + stat.additions,
        0,
      );
      deletions += untrackedStats.reduce(
        (sum, stat) => sum + stat.deletions,
        0,
      );
    }

    return {
      files: scopeFiles.length,
      additions,
      deletions,
    };
  }

  private async getUpstream(git: SimpleGit): Promise<string | null> {
    try {
      return (
        await git.raw([
          'rev-parse',
          '--abbrev-ref',
          '--symbolic-full-name',
          '@{u}',
        ])
      ).trim();
    } catch {
      return null;
    }
  }

  private async getAheadBehind(
    git: SimpleGit,
    branch: string,
    upstream: string,
  ): Promise<{ ahead: number; behind: number }> {
    try {
      const counts = (
        await git.raw([
          'rev-list',
          '--left-right',
          '--count',
          `${branch}...${upstream}`,
        ])
      ).trim();
      const [aheadCount, behindCount] = counts.split(/\s+/);
      return {
        ahead: Number(aheadCount) || 0,
        behind: Number(behindCount) || 0,
      };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  }

  private async readNumstat(
    worktreePath: string,
    staged: boolean,
  ): Promise<{ additions: number; deletions: number }> {
    const git: SimpleGit = worktreeSimpleGit(worktreePath);
    const args = staged
      ? ['diff', '--cached', '--numstat', '--find-renames']
      : ['diff', '--numstat', '--find-renames'];
    const output = await git.raw(args);
    const lines = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    return lines.reduce(
      (stats, line) => {
        const [additions, deletions] = line.split('\t');
        const parsedAdditions =
          additions === '-' ? 0 : Number.parseInt(additions, 10);
        const parsedDeletions =
          deletions === '-' ? 0 : Number.parseInt(deletions, 10);
        return {
          additions:
            stats.additions +
            (Number.isFinite(parsedAdditions) ? parsedAdditions : 0),
          deletions:
            stats.deletions +
            (Number.isFinite(parsedDeletions) ? parsedDeletions : 0),
        };
      },
      { additions: 0, deletions: 0 },
    );
  }

  private async readUntrackedFileStats(
    worktreePath: string,
    relativePath: string,
  ): Promise<{ additions: number; deletions: number }> {
    try {
      const contents = await readFile(`${worktreePath}/${relativePath}`);
      if (contents.includes(0)) {
        return { additions: 0, deletions: 0 };
      }

      const text = contents.toString('utf8');
      if (!text.length) {
        return { additions: 0, deletions: 0 };
      }

      const additions = text.endsWith('\n')
        ? text.split('\n').length - 1
        : text.split('\n').length;
      return { additions, deletions: 0 };
    } catch {
      return { additions: 0, deletions: 0 };
    }
  }

  private buildCompactStatusSummary(files: string[]): string {
    const visibleFiles = files.slice(0, MAX_COMMIT_MESSAGE_STATUS_FILES);
    const lines = visibleFiles.map((file) => `- ${file}`);
    if (files.length > visibleFiles.length) {
      lines.push(`- ...and ${files.length - visibleFiles.length} more`);
    }
    return lines.join('\n');
  }

  private buildCompactLog(commits: CommitInfo[]): string {
    return commits
      .slice(0, MAX_COMMIT_MESSAGE_LOG_ENTRIES)
      .map((commit) => `- ${commit.shortHash} ${commit.message}`)
      .join('\n');
  }

  private truncateDiffForPrompt(diff: string): string {
    if (diff.length <= MAX_COMMIT_MESSAGE_DIFF_CHARS) {
      return diff;
    }

    return `${diff.slice(0, MAX_COMMIT_MESSAGE_DIFF_CHARS)}\n\n[diff truncated for commit message generation]`;
  }

  private async generateCommitMessageWithClaude(input: {
    worktreePath: string;
    branchName: string;
    files: string[];
    diff: string;
    compactStatus: string;
    compactLog: string;
  }): Promise<CommitMessageSuggestion | null> {
    const sdk = await this.loadClaudeSdk();
    if (!sdk) {
      this.logger.warn('[commit-message] claude SDK not available, skipping');
      return null;
    }

    let assistantText = '';
    const runtimeQuery = sdk.query({
      prompt: this.buildCommitMessagePrompt(input),
      options: {
        cwd: input.worktreePath,
        model: 'haiku',
        permissionMode: 'plan',
        canUseTool: async () => ({
          behavior: 'deny' as const,
          message: 'Tool use disabled',
        }),
        pathToClaudeCodeExecutable: CLAUDE_BIN,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
        },
        tools: {
          type: 'preset',
          preset: 'claude_code',
        },
        env: buildAugmentedEnv(process.env, input.worktreePath),
      },
    });

    try {
      for await (const message of runtimeQuery) {
        if (message.type !== 'assistant') continue;
        assistantText += this.extractAssistantText(message);
      }
    } catch (error: any) {
      this.logger.warn(
        `[commit-message] claude query failed: ${error?.message ?? String(error)}`,
      );
      return null;
    } finally {
      runtimeQuery.close();
    }

    const suggestion = this.parseCommitSuggestion(assistantText);
    if (!suggestion && assistantText.trim()) {
      this.logger.warn(
        `[commit-message] claude response could not be parsed: ${assistantText.trim()}`,
      );
    }
    return suggestion;
  }

  private async generateCommitMessageWithCodex(input: {
    worktreePath: string;
    branchName: string;
    files: string[];
    diff: string;
    compactStatus: string;
    compactLog: string;
  }): Promise<CommitMessageSuggestion | null> {
    try {
      const { Codex } = await importCodexSdk('@openai/codex-sdk');
      const codex = new Codex({
        env: this.toStringEnv(
          buildAugmentedEnv(process.env, input.worktreePath),
        ),
      });
      const thread = codex.startThread({
        workingDirectory: input.worktreePath,
        skipGitRepoCheck: true,
        model: DEFAULT_CODEX_MODEL,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
      });
      const result = await thread.run(this.buildCommitMessagePrompt(input));
      const suggestion = this.parseCommitSuggestion(result.finalResponse, 'codex');
      if (!suggestion && result.finalResponse?.trim()) {
        this.logger.warn(
          `[commit-message] codex response could not be parsed: ${result.finalResponse.trim()}`,
        );
      }
      return suggestion;
    } catch (error: any) {
      this.logger.warn(
        `[commit-message] codex query failed: ${error?.message ?? String(error)}`,
      );
      return null;
    }
  }

  private async generateCommitMessageWithPi(input: {
    worktreePath: string;
    branchName: string;
    files: string[];
    diff: string;
    compactStatus: string;
    compactLog: string;
  }): Promise<CommitMessageSuggestion | null> {
    const runtime = new PiSessionRuntime({
      cwd: input.worktreePath,
      timeoutMs: 60_000,
    });
    let assistantDeltaText = '';
    let assistantFinalText = '';
    let cleanupCompletion = () => {};

    const completionPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanupCompletion();
        reject(new Error('Pi commit message generation timed out.'));
      }, 60_000);

      const onEvent = (event: Record<string, unknown>) => {
        if (event.type === 'agent_end') {
          cleanupCompletion();
          resolve();
          return;
        }
        if (event.type === 'error') {
          cleanupCompletion();
          reject(new Error(String(event.message ?? 'Pi runtime error')));
          return;
        }
        if (event.type === 'message_update') {
          const update = event.assistantMessageEvent as
            | Record<string, unknown>
            | undefined;
          if (
            update?.type === 'text_delta' &&
            typeof update.delta === 'string'
          ) {
            assistantDeltaText += update.delta;
          }
          return;
        }
        if (event.type === 'message_end') {
          const message = event.message as Record<string, unknown> | undefined;
          if (message?.role === 'assistant') {
            const text = this.extractPiMessageText(message);
            if (text) assistantFinalText = text;
          }
        }
      };

      const onExit = (details: { message?: string; stderr?: string }) => {
        cleanupCompletion();
        reject(
          new Error(
            details.stderr?.trim() ||
              details.message ||
              'Pi RPC process exited.',
          ),
        );
      };

      cleanupCompletion = () => {
        clearTimeout(timer);
        runtime.off('event', onEvent);
        runtime.off('exit', onExit);
      };

      runtime.on('event', onEvent);
      runtime.on('exit', onExit);
    });

    try {
      await runtime.send({
        type: 'prompt',
        message: this.buildCommitMessagePrompt(input),
      });
      await completionPromise;
      return this.parseCommitSuggestion(
        assistantFinalText || assistantDeltaText,
        'pi',
      );
    } catch {
      cleanupCompletion();
      return null;
    } finally {
      await runtime.stop().catch(() => undefined);
    }
  }

  private generateCommitMessageWithProvider(
    provider: CommitMessageProvider,
    input: {
      worktreePath: string;
      branchName: string;
      files: string[];
      diff: string;
      compactStatus: string;
      compactLog: string;
    },
  ): Promise<CommitMessageSuggestion | null> {
    switch (provider) {
      case 'claude':
        return this.generateCommitMessageWithClaude(input);
      case 'codex':
        return this.generateCommitMessageWithCodex(input);
      case 'pi':
        return this.generateCommitMessageWithPi(input);
    }
  }

  private buildCommitMessagePrompt(input: {
    branchName: string;
    compactLog: string;
    compactStatus: string;
    diff: string;
  }): string {
    return [
      'Generate the exact commit message that will be passed to git commit -m.',
      'Your response is machine-read and must be strict JSON only.',
      'Return exactly one JSON object with this shape:',
      '{"subject":"type(scope): imperative description","body":null}',
      '',
      'Hard output rules:',
      '- Do not include greetings, explanations, analysis, markdown fences, or extra text.',
      '- Do not return the final commit message as plain text.',
      '- Do not include JSON inside subject or body; JSON is only the transport format.',
      '- The subject string is the exact first line that will be committed.',
      '- The body string, when non-null, is the exact commit body that will be committed after a blank line.',
      '',
      'Subject rules:',
      '- Use Conventional Commits: <type>(<optional scope>): <description>.',
      '- Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.',
      '- Prefer a lowercase scope when clear, such as backend, frontend, git, db, branches, projects, deps.',
      '- Use an imperative lowercase description, for example "add", "fix", "remove", or "refactor".',
      '- Describe the semantic product or code behavior change, not just file operations.',
      '- Do not summarize as "rename files", "update files", or "change N files" when the diff changes behavior or adds a concept.',
      '- Keep the full subject at most 72 characters.',
      '- Do not end the subject with a period.',
      '',
      'Body rules:',
      '- Use null unless extra motivation, context, or migration impact materially helps.',
      '- Do not list files unless the file list is the main point of the change.',
      '',
      'Examples of valid responses:',
      '{"subject":"fix(git): reject invalid generated commit subjects","body":null}',
      '{"subject":"feat(frontend): add branch search filters","body":"Expose status and owner filters in the branch picker."}',
      '',
      `Branch: ${input.branchName}`,
      'Recent commits:',
      input.compactLog || '- none',
      '',
      'Staged files:',
      input.compactStatus || '- none',
      '',
      'Unified diff:',
      input.diff || '[empty diff]',
    ].join('\n');
  }

  private async loadClaudeSdk(): Promise<{
    query: (typeof import('@anthropic-ai/claude-agent-sdk'))['query'];
  } | null> {
    try {
      return await import('@anthropic-ai/claude-agent-sdk');
    } catch {
      return null;
    }
  }

  private extractAssistantText(message: any): string {
    if (message?.type !== 'assistant') {
      return '';
    }

    const content = Array.isArray(message.message?.content)
      ? message.message.content
      : [];
    return content
      .map((part: unknown) => {
        if (
          typeof part === 'object' &&
          part &&
          'type' in part &&
          part.type === 'text' &&
          'text' in part &&
          typeof part.text === 'string'
        ) {
          return part.text;
        }
        return '';
      })
      .join('');
  }

  private extractPiMessageText(message: Record<string, unknown>): string {
    const content = Array.isArray(message.content) ? message.content : [];
    return content
      .map((part) => {
        if (
          part &&
          typeof part === 'object' &&
          (part as Record<string, unknown>).type === 'text' &&
          typeof (part as Record<string, unknown>).text === 'string'
        ) {
          return (part as Record<string, string>).text;
        }
        return '';
      })
      .join('');
  }

  private parseCommitSuggestion(
    raw: string,
    source: CommitMessageSuggestion['source'] = 'claude',
  ): CommitMessageSuggestion | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const normalized = trimmed
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    try {
      const parsed = JSON.parse(normalized);
      const subject = this.normalizeCommitSubject(parsed?.subject);
      if (!subject) {
        return null;
      }

      return {
        subject,
        body:
          typeof parsed.body === 'string' && parsed.body.trim()
            ? parsed.body.trim()
            : null,
        confidence: 'medium',
        source,
      };
    } catch {
      return null;
    }
  }

  private normalizeCommitSubject(subject: unknown): string | null {
    if (typeof subject !== 'string') {
      return null;
    }

    const normalized = subject.trim().replace(/\s+/g, ' ');
    if (!normalized) {
      return null;
    }

    if (!CONVENTIONAL_COMMIT_SUBJECT_PATTERN.test(normalized)) {
      return null;
    }

    return normalized;
  }

  private getFileStatus(
    status: StatusResult,
    path: string,
  ): FileStatus['status'] {
    if (status.created.includes(path)) return 'added';
    if (status.deleted.includes(path)) return 'deleted';
    if (status.renamed.some((r) => r.to === path)) return 'renamed';
    if (status.conflicted.includes(path)) return 'conflicted';
    return 'modified';
  }

  private getRelativeDate(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 7) return date.toLocaleDateString();
    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'just now';
  }

  private async runExternalCommitMessageGenerator(input: {
    worktreePath: string;
    branchName: string;
    files: string[];
    diff: string;
  }): Promise<CommitMessageSuggestion | null> {
    const generatorBin =
      process.env.ELEVENEX_COMMIT_MESSAGE_GENERATOR_BIN?.trim();
    if (!generatorBin) {
      return null;
    }

    let extraArgs: string[] = [];
    const rawArgs = process.env.ELEVENEX_COMMIT_MESSAGE_GENERATOR_ARGS?.trim();
    if (rawArgs) {
      try {
        const parsed = JSON.parse(rawArgs);
        if (
          Array.isArray(parsed) &&
          parsed.every((value) => typeof value === 'string')
        ) {
          extraArgs = parsed;
        }
      } catch {
        // Ignore malformed args and fall back.
      }
    }

    try {
      const stdout = await this.execFileWithInput(
        generatorBin,
        extraArgs,
        JSON.stringify(input),
        {
          cwd: input.worktreePath,
          timeout: 15_000,
          maxBuffer: 2_000_000,
          env: buildAugmentedEnv(process.env, input.worktreePath),
        },
      );
      const parsed = JSON.parse(stdout);
      const subject = this.normalizeCommitSubject(parsed?.subject);
      if (!subject) {
        return null;
      }

      return {
        subject,
        body:
          typeof parsed.body === 'string' && parsed.body.trim().length > 0
            ? parsed.body.trim()
            : null,
        confidence:
          parsed.confidence === 'high' || parsed.confidence === 'medium'
            ? parsed.confidence
            : 'low',
        source: 'external',
      };
    } catch {
      return null;
    }
  }

  private buildFallbackCommitMessage(
    stagedFiles: string[],
    diff: string,
  ): CommitMessageSuggestion {
    const filenames = stagedFiles.map((file) => file.split('/').pop() || file);
    const lineCount = diff
      .split('\n')
      .filter(
        (line) =>
          (line.startsWith('+') || line.startsWith('-')) &&
          !line.startsWith('+++') &&
          !line.startsWith('---'),
      ).length;
    const hasRenames = diff.includes('rename from ');
    const hasContentChanges = lineCount > 0;

    let type = 'chore';
    let verb = 'update';
    if (diff.includes('new file mode')) {
      type = 'feat';
      verb = 'add';
    } else if (diff.includes('deleted file mode')) {
      type = 'chore';
      verb = 'remove';
    } else if (hasRenames && !hasContentChanges) {
      type = 'chore';
      verb = 'rename';
    } else if (stagedFiles.some((file) => /test|spec/i.test(file))) {
      type = 'test';
      verb = 'update';
    } else if (stagedFiles.some((file) => /readme|docs?\//i.test(file))) {
      type = 'docs';
      verb = 'update';
    } else if (lineCount > 120) {
      type = 'refactor';
      verb = 'refactor';
    }

    const target = this.buildFallbackCommitTarget(
      stagedFiles,
      filenames,
      verb,
      hasContentChanges,
    );

    const conventionalScope = this.extractFileScope(stagedFiles);
    const scopedType = conventionalScope
      ? `${type}(${conventionalScope})`
      : type;
    const subject = `${scopedType}: ${verb} ${target}`;
    return {
      subject:
        this.normalizeCommitSubject(subject) ??
        `${scopedType}: update staged changes`,
      body:
        stagedFiles.length > 1
          ? `Files:\n${stagedFiles.map((file) => `- ${file}`).join('\n')}`
          : null,
      confidence: 'low',
      source: 'fallback',
    };
  }

  private buildFallbackCommitTarget(
    stagedFiles: string[],
    filenames: string[],
    verb: string,
    hasContentChanges: boolean,
  ): string {
    if (stagedFiles.length === 1) {
      return filenames[0];
    }

    if (stagedFiles.length <= 3) {
      return filenames.join(', ');
    }

    if (verb === 'rename' && !hasContentChanges) {
      return 'files';
    }

    if (verb === 'add') {
      return 'files';
    }

    return 'staged changes';
  }

  private extractFileScope(stagedFiles: string[]): string {
    const scopes = stagedFiles
      .map((file) => {
        if (file.startsWith('apps/backend/src/git/')) return 'git';
        if (file.startsWith('apps/backend/src/database/')) return 'db';
        if (file.startsWith('apps/backend/')) return 'backend';
        if (file.startsWith('apps/frontend/')) return 'frontend';
        if (file.startsWith('apps/electron/')) return 'electron';
        if (file.startsWith('vscode-scm-extension/')) return 'scm';
        if (file.startsWith('vscode-filesystem-provider/')) return 'filesystem';
        if (file === 'package.json' || file === 'pnpm-lock.yaml') return 'deps';
        return '';
      })
      .filter(Boolean);

    const uniqueScopes = new Set(scopes);
    return uniqueScopes.size === 1 ? scopes[0] : '';
  }

  private toStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  }

  private normalizeCommitMessageProvider(
    provider: AgentProviderId | undefined,
  ): CommitMessageProvider {
    if (provider === 'claude' || provider === 'codex' || provider === 'pi') {
      return provider;
    }
    throw new BadRequestException(
      provider
        ? `Commit message generation is not supported for provider "${provider}".`
        : 'Commit message generation requires an active provider.',
    );
  }

  private execFileWithInput(
    command: string,
    args: string[],
    input: string,
    options: ExecFileOptions,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(command, args, options, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(typeof stdout === 'string' ? stdout : stdout.toString('utf8'));
      });

      child.stdin?.end(input);
    });
  }
}
