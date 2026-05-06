import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { execFile, type ExecFileOptions } from 'node:child_process';
import simpleGit, { SimpleGit, StatusResult, LogResult } from 'simple-git';

import { buildAugmentedEnv, findBinary } from '../config/system-paths.js';

const SAFE_REF_PATTERN = /^[a-zA-Z0-9\/_.-]+$/;
const CLAUDE_BIN = findBinary('claude') ?? 'claude';
const MAX_COMMIT_MESSAGE_DIFF_CHARS = 24_000;
const MAX_COMMIT_MESSAGE_LOG_ENTRIES = 8;
const MAX_COMMIT_MESSAGE_STATUS_FILES = 16;

export function isValidGitRef(ref: string): boolean {
  if (!ref || ref.length === 0) return false;
  if (ref.includes('..')) return false;
  return SAFE_REF_PATTERN.test(ref);
}

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
  source: 'external' | 'claude' | 'fallback';
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
    const git: SimpleGit = simpleGit(worktreePath);
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
    const git: SimpleGit = simpleGit(worktreePath);
    const [files, status, stagedStats, unstagedStats] = await Promise.all([
      this.getStatus(worktreePath),
      git.status(),
      this.getScopeStats(worktreePath, true),
      this.getScopeStats(worktreePath, false),
    ]);

    const branch = status.current || 'HEAD';

    return {
      branch,
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
    const git: SimpleGit = simpleGit(worktreePath);
    await git.add(files);
  }

  async unstageFiles(worktreePath: string, files: string[]): Promise<void> {
    const git: SimpleGit = simpleGit(worktreePath);
    await git.raw(['reset', 'HEAD', '--', ...files]);
  }

  async commit(
    worktreePath: string,
    options: {
      message?: string;
      includeUnstaged?: boolean;
      requestId?: string;
    } = {},
  ): Promise<CommitResult> {
    const requestId = options.requestId ?? this.createRequestId();
    const git: SimpleGit = simpleGit(worktreePath);

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
        const suggestion = await this.suggestCommitMessage(worktreePath);
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
  ): Promise<CommitMessageSuggestion> {
    const requestId = this.createRequestId();
    this.logger.log(
      `[commit-message:${requestId}] suggestion started worktreePath="${worktreePath}"`,
    );

    const git: SimpleGit = simpleGit(worktreePath);
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

      const claudeSuggestion = await this.generateCommitMessageWithClaude({
        worktreePath,
        branchName: currentBranch,
        files: stagedFiles,
        diff: truncatedDiff,
        compactStatus: compressedStatus,
        compactLog: compressedLog,
      });

      if (claudeSuggestion) {
        this.logger.log(
          `[commit-message:${requestId}] suggestion completed source=claude confidence=${claudeSuggestion.confidence} subject="${this.preview(claudeSuggestion.subject)}"`,
        );
        return claudeSuggestion;
      }

      const externalSuggestion = await this.runExternalCommitMessageGenerator({
        worktreePath,
        branchName: currentBranch,
        files: stagedFiles,
        diff: truncatedDiff,
      });

      if (externalSuggestion) {
        this.logger.log(
          `[commit-message:${requestId}] suggestion completed source=external confidence=${externalSuggestion.confidence} subject="${this.preview(externalSuggestion.subject)}"`,
        );
        return externalSuggestion;
      }

      const fallbackSuggestion = this.buildFallbackCommitMessage(
        stagedFiles,
        diff,
        currentBranch,
      );
      this.logger.log(
        `[commit-message:${requestId}] suggestion completed source=fallback confidence=${fallbackSuggestion.confidence} subject="${this.preview(fallbackSuggestion.subject)}"`,
      );
      return fallbackSuggestion;
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
    const git: SimpleGit = simpleGit(worktreePath);
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
    const git: SimpleGit = simpleGit(worktreePath);
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
    const git: SimpleGit = simpleGit(worktreePath);

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
    const git: SimpleGit = simpleGit(worktreePath);

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

  private async readNumstat(
    worktreePath: string,
    staged: boolean,
  ): Promise<{ additions: number; deletions: number }> {
    const git: SimpleGit = simpleGit(worktreePath);
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
      return null;
    }

    let assistantText = '';
    const runtimeQuery = sdk.query({
      prompt: [
        'Write a git commit message for the staged changes.',
        'Return strict JSON with this exact shape: {"subject":"...","body":"...|null"}',
        'Rules:',
        '- subject must be imperative, concise, and at most 72 characters',
        '- body is optional and must be null unless extra context materially helps',
        '- do not mention tests or files unless the diff makes that central',
        '- do not wrap the JSON in markdown fences',
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
      ].join('\n'),
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
    } catch {
      return null;
    } finally {
      runtimeQuery.close();
    }

    return this.parseCommitSuggestion(assistantText);
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

  private parseCommitSuggestion(raw: string): CommitMessageSuggestion | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const normalized = trimmed
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    try {
      const parsed = JSON.parse(normalized);
      if (
        !parsed ||
        typeof parsed.subject !== 'string' ||
        !parsed.subject.trim()
      ) {
        return null;
      }

      return {
        subject: parsed.subject.trim().slice(0, 72),
        body:
          typeof parsed.body === 'string' && parsed.body.trim()
            ? parsed.body.trim()
            : null,
        confidence: 'medium',
        source: 'claude',
      };
    } catch {
      const [subject, ...rest] = normalized.split('\n').filter(Boolean);
      if (!subject?.trim()) return null;
      return {
        subject: subject.trim().slice(0, 72),
        body: rest.length > 0 ? rest.join('\n').trim() || null : null,
        confidence: 'low',
        source: 'claude',
      };
    }
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
      if (
        !parsed ||
        typeof parsed.subject !== 'string' ||
        !parsed.subject.trim()
      ) {
        return null;
      }

      return {
        subject: parsed.subject.trim(),
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
    branchName: string,
  ): CommitMessageSuggestion {
    const filenames = stagedFiles.map((file) => file.split('/').pop() || file);
    const scope = this.extractBranchScope(branchName);
    const lineCount = diff
      .split('\n')
      .filter(
        (line) =>
          (line.startsWith('+') || line.startsWith('-')) &&
          !line.startsWith('+++') &&
          !line.startsWith('---'),
      ).length;

    let verb = 'update';
    if (stagedFiles.length === 1 && diff.includes('new file mode')) {
      verb = 'add';
    } else if (diff.includes('deleted file mode')) {
      verb = 'remove';
    } else if (diff.includes('rename from ')) {
      verb = 'rename';
    } else if (stagedFiles.some((file) => /test|spec/i.test(file))) {
      verb = 'test';
    } else if (stagedFiles.some((file) => /readme|docs?\//i.test(file))) {
      verb = 'document';
    } else if (lineCount > 120) {
      verb = 'refactor';
    }

    const target =
      stagedFiles.length === 1
        ? filenames[0]
        : stagedFiles.length <= 3
          ? filenames.join(', ')
          : `${stagedFiles.length} files`;

    const subject = scope ? `${verb} ${scope} ${target}` : `${verb} ${target}`;
    return {
      subject: this.capitalize(subject).slice(0, 72),
      body:
        stagedFiles.length > 1
          ? `Files:\n${stagedFiles.map((file) => `- ${file}`).join('\n')}`
          : null,
      confidence: 'low',
      source: 'fallback',
    };
  }

  private extractBranchScope(branchName: string): string {
    const trimmed = branchName.trim();
    if (!trimmed) return '';
    const parts = trimmed.split('/').filter(Boolean);
    if (parts.length < 2) {
      return '';
    }

    return parts[0].replace(/[-_]+/g, ' ');
  }

  private capitalize(value: string): string {
    if (!value) return value;
    return value.charAt(0).toUpperCase() + value.slice(1);
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
