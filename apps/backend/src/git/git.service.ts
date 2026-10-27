import { yieldEditorWork } from '../files/editor-work.js';
import { EditorBaselines } from './editor-baselines.js';
import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile, spawn, type ExecFileOptions } from 'node:child_process';
import * as path from 'node:path';
import { SimpleGit, StatusResult, LogResult } from 'simple-git';
import type { RemoteWithRefs } from 'simple-git';

import {
  buildAugmentedEnv,
  worktreeSimpleGit,
} from '../config/system-paths.js';
import type { AgentProviderId } from '../agent-runtime/agent-runtime.types.js';
import {
  TextAgentGenerationService,
  type GenerateTextWithAgentResult,
} from '../agent-generation/text-agent-generation.service.js';
import {
  clearWorktreeFingerprintCache,
  readWorktreeStatusSnapshot,
} from './git-worktree-fingerprint.js';
import { readCurrentBranch } from './git-head.js';
import { verbatimPathspecArgs } from './git-pathspec.js';
import {
  hasTrackedChanges,
  readWorktreeStatus,
  trackedStatusPaths,
} from './worktree-status-reader.js';

import { GitByteLru, GitCacheBudget } from './git-cache.js';
import {
  readLocalRefSnapshot,
  clearLocalRefState,
  readPathVersion,
} from './git-local-state.js';
import { scheduledReadGit } from './git-read-scheduler.js';
import { readWorktreeTextStats } from './git-file-stats.js';
import type { WorktreeStatusFingerprintSnapshot } from './git-worktree-fingerprint.js';
import { registerWorktreeCache } from './git-worktree-cache-lifecycle.js';

const SAFE_REF_PATTERN = /^[a-zA-Z0-9\/_.-]+$/;
const MAX_COMMIT_MESSAGE_DIFF_CHARS = 24_000;
const MAX_COMMIT_MESSAGE_LOG_ENTRIES = 8;
const MAX_COMMIT_MESSAGE_STATUS_FILES = 16;
const COMMIT_MESSAGE_MAX_ATTEMPTS = 3;
const UNTRACKED_STATS_CONCURRENCY = 16;
const CONVENTIONAL_COMMIT_TYPES_EXAMPLE =
  'feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert';
const MAX_COMMIT_SUBJECT_LENGTH = 200;
const COMMIT_CONVENTION_DOC_FILENAMES = [
  'AGENTS.md',
  'COMMIT_CONVENTION.md',
  'CONTRIBUTING.md',
];
const MAX_COMMIT_MESSAGE_CONVENTION_DOC_CHARS = 6_000;
const COMMIT_MESSAGE_CLAUDE_SYSTEM_PROMPT =
  'You generate git commit messages. You have no tool access. Follow the ' +
  'user instructions exactly and respond with nothing but the requested JSON.';
type CommitMessageProvider = 'claude' | 'codex' | 'pi' | 'opencode';
interface CommitMessagePromptInput {
  worktreePath: string;
  branchName: string;
  files: string[];
  diff: string;
  compactStatus: string;
  compactLog: string;
  conventionDocs: string;
}
interface RemoteBranchMatch {
  ref: string;
  sha: string;
}

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
  source: 'external' | 'claude' | 'codex' | 'pi' | 'opencode' | 'fallback';
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
  // Configured tracking ref or a comparable same-named remote branch. A failed
  // fallback lookup/comparison leaves this null rather than implying sync.
  upstream: string | null;
  headSha: string | null;
  worktreeFingerprint: string;
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
  private readonly unregisterCache = registerWorktreeCache(this);
  private readonly logger = new Logger(GitService.name);
  private readonly statsBudget = new GitCacheBudget(8 * 1024 * 1024);
  private readonly scopeStatsCache = new GitByteLru<{
    version: string;
    stats: GitScopeSummary;
  }>(this.statsBudget);
  private readonly divergenceCache = new GitByteLru<{
    ahead: number;
    behind: number;
  }>(this.statsBudget);
  private readonly observedLocalState = new GitByteLru<string>(
    this.statsBudget,
  );
  private readonly statusSummaryInFlight = new Map<
    string,
    Promise<GitStatusSummary>
  >();

  constructor(
    private readonly textAgentGenerationService: TextAgentGenerationService,
  ) {}

  async getEditorStatus(
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<FileStatus[]> {
    const raw = await this.editorBaselines.status(worktreePath, signal);
    const files: FileStatus[] = [];
    let start = 0,
      count = 0;
    while (start < raw.length) {
      signal?.throwIfAborted();
      const end = raw.indexOf('\0', start);
      if (end === -1) break;
      const x = raw[start],
        y = raw[start + 1];
      const file = raw.slice(start + 3, end);
      start = end + 1;
      let oldPath: string | undefined;
      if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
        const oldEnd = raw.indexOf('\0', start);
        oldPath = raw.slice(start, oldEnd);
        start = oldEnd + 1;
      }
      if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(x + y))
        files.push({ path: file, status: 'conflicted', staged: false });
      else if (x === '?')
        files.push({ path: file, status: 'untracked', staged: false });
      else
        for (const [code, staged] of [
          [x, true],
          [y, false],
        ] as const) {
          if (!code || code === ' ' || code === '!') continue;
          const status =
            code === 'A'
              ? 'added'
              : code === 'D'
                ? 'deleted'
                : code === 'R' || code === 'C'
                  ? 'renamed'
                  : 'modified';
          files.push({
            path: file,
            status,
            staged,
            ...(oldPath ? { oldPath } : {}),
          });
        }
      if (++count % 2048 === 0) await yieldEditorWork();
    }
    return files;
  }

  releaseWorktree(worktreePath: string): void {
    this.invalidateStatusSummaries(worktreePath);
    this.observedLocalState.delete(worktreePath);
    for (const staged of [false, true])
      this.scopeStatsCache.delete([worktreePath, staged].join('\0'));
  }

  onModuleDestroy(): void {
    this.unregisterCache();
    this.scopeStatsCache.clear();
    this.divergenceCache.clear();
    this.observedLocalState.clear();
  }

  async getStatus(worktreePath: string): Promise<FileStatus[]> {
    const status: StatusResult = await readWorktreeStatus(worktreePath);
    return this.toFileStatuses(status);
  }

  private toFileStatuses(status: StatusResult): FileStatus[] {
    const files: FileStatus[] = [];
    const conflictedPaths = new Set(status.conflicted);
    const stagedPaths = new Set(status.staged);
    const createdPaths = new Set(status.created);
    const deletedPaths = new Set(status.deleted);
    const renamedPaths = new Set(status.renamed.map((file) => file.to));
    // simple-git's modified list includes index-only changes too.
    const stagedOnlyPaths = new Set(
      status.files
        .filter((file) => file.index !== ' ' && file.working_dir === ' ')
        .map((file) => file.path),
    );

    status.conflicted.forEach((path) => {
      files.push({ path, status: 'conflicted', staged: false });
    });

    status.staged.forEach((path) => {
      if (conflictedPaths.has(path)) return;
      if (renamedPaths.has(path)) return;
      files.push({
        path,
        status: createdPaths.has(path)
          ? 'added'
          : deletedPaths.has(path)
            ? 'deleted'
            : 'modified',
        staged: true,
      });
    });

    status.modified.forEach((path) => {
      if (conflictedPaths.has(path)) return;
      if (stagedOnlyPaths.has(path)) return;
      files.push({ path, status: 'modified', staged: false });
    });

    status.not_added.forEach((path) => {
      if (conflictedPaths.has(path)) return;
      files.push({ path, status: 'untracked', staged: false });
    });

    status.deleted.forEach((path) => {
      if (conflictedPaths.has(path)) return;
      if (stagedPaths.has(path)) return;
      files.push({
        path,
        status: 'deleted',
        staged: false,
      });
    });

    status.renamed.forEach(({ from, to }) => {
      if (conflictedPaths.has(to)) return;
      files.push({ path: to, status: 'renamed', staged: true, oldPath: from });
    });

    return files.sort((left, right) => {
      if (left.staged !== right.staged) return left.staged ? -1 : 1;
      return left.path.localeCompare(right.path);
    });
  }

  getStatusSummary(
    worktreePath: string,
    options: { conflictsOnly?: boolean } = {},
  ): Promise<GitStatusSummary> {
    const normalizedPath = path.resolve(worktreePath);
    const conflictsOnly = Boolean(options.conflictsOnly);
    const key = JSON.stringify([normalizedPath, conflictsOnly]);
    const existing = this.statusSummaryInFlight.get(key);
    if (existing) return existing;

    const request = this.loadStatusSummary(normalizedPath, conflictsOnly);
    this.statusSummaryInFlight.set(key, request);
    const cleanup = () => {
      if (this.statusSummaryInFlight.get(key) === request) {
        this.statusSummaryInFlight.delete(key);
      }
    };
    // Share pending work only: the next poll must read fresh stats and refs.
    void request.then(cleanup, cleanup);
    return request;
  }

  private invalidateStatusSummaries(worktreePath: string): void {
    const normalizedPath = path.resolve(worktreePath);
    clearWorktreeFingerprintCache(normalizedPath);
    clearLocalRefState(normalizedPath);
    // A request can still be waiting for remote metadata after its local scan.
    // New readers after a mutation must not join that pre-mutation summary.
    for (const conflictsOnly of [false, true]) {
      this.statusSummaryInFlight.delete(
        JSON.stringify([normalizedPath, conflictsOnly]),
      );
    }
  }

  private async loadStatusSummary(
    worktreePath: string,
    conflictsOnly: boolean,
  ): Promise<GitStatusSummary> {
    const git = scheduledReadGit(
      worktreeSimpleGit(worktreePath, { readOnly: true }),
      worktreePath,
      -5,
    );
    if (conflictsOnly) return this.getConflictsOnlySummary(git);
    const local = await readLocalRefSnapshot(git, worktreePath);
    const { headSha } = local;
    const localVersion = [local.branch, headSha, local.indexVersion].join('\0');
    const observed = this.observedLocalState.get(worktreePath);
    if (observed !== undefined && observed !== localVersion)
      clearWorktreeFingerprintCache(worktreePath);
    this.observedLocalState.set(worktreePath, localVersion);
    const statusSnapshot = await readWorktreeStatusSnapshot(worktreePath, git, {
      validateCached: true,
    });
    const status = statusSnapshot.status;
    const files = this.toFileStatuses(status);
    const [stagedStats, unstagedStats] = await Promise.all([
      this.getScopeStats(
        worktreePath,
        true,
        files,
        [headSha, local.indexVersion].join('\0'),
        statusSnapshot,
      ),
      this.getScopeStats(
        worktreePath,
        false,
        files,
        [local.indexVersion, statusSnapshot.fingerprint].join('\0'),
        statusSnapshot,
      ),
    ]);

    const branch = local.branch;
    let upstream = await this.getUpstream(git);
    let ahead = 0;
    let behind = 0;
    const divergenceScope = [
      local.commonDir,
      await readPathVersion(path.join(local.commonDir, 'shallow')),
    ].join('\0');
    if (upstream) {
      ({ ahead, behind } = await this.getAheadBehind(
        git,
        branch,
        upstream,
        headSha,
        await local.resolveRef(upstream),
        divergenceScope,
      ));
    } else {
      // Preserve same-named remote branch detection for branches without -u,
      // including repos whose fetch refspec excludes the current branch.
      const remoteMatch = await this.findMatchingRemoteBranch(
        git,
        worktreePath,
        branch,
      );
      if (remoteMatch) {
        const counts = await this.getAheadBehindBySha(
          git,
          headSha ?? branch,
          remoteMatch.sha,
          divergenceScope,
        );
        // A remote can advertise an object we have never fetched. Keep upstream
        // unresolved in that case; upstream + zero counts would imply synced.
        if (counts) {
          upstream = remoteMatch.ref;
          ({ ahead, behind } = counts);
        }
      }
    }

    return {
      branch,
      upstream,
      headSha,
      worktreeFingerprint: statusSnapshot.fingerprint,
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

  private async getConflictsOnlySummary(
    git: SimpleGit,
  ): Promise<GitStatusSummary> {
    const [rawConflicts, branch, headSha] = await Promise.all([
      git.raw(['diff', '--name-only', '--diff-filter=U', '-z']).catch(() => ''),
      this.getCurrentBranch(git),
      git
        .revparse(['HEAD'])
        .then((value) => value.trim())
        .catch(() => null),
    ]);
    const files: FileStatus[] = rawConflicts
      .split('\0')
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
      .map((path) => ({
        path,
        status: 'conflicted' as const,
        staged: false,
      }));
    const fingerprint = createHash('sha256')
      .update(headSha ?? '')
      .update('\0')
      .update(files.map((file) => file.path).join('\0'))
      .digest('hex');

    return {
      branch: branch || 'HEAD',
      upstream: null,
      headSha,
      worktreeFingerprint: fingerprint,
      ahead: 0,
      behind: 0,
      hasChanges: files.length > 0,
      files,
      staged: { files: 0, additions: 0, deletions: 0 },
      unstaged: { files: files.length, additions: 0, deletions: 0 },
      total: { files: files.length, additions: 0, deletions: 0 },
    };
  }

  async stageFiles(worktreePath: string, files: string[]): Promise<void> {
    this.invalidateStatusSummaries(worktreePath);
    const git: SimpleGit = worktreeSimpleGit(worktreePath);
    try {
      await git.add(files);
    } finally {
      this.invalidateStatusSummaries(worktreePath);
    }
  }

  async unstageFiles(worktreePath: string, files: string[]): Promise<void> {
    this.invalidateStatusSummaries(worktreePath);
    const git: SimpleGit = worktreeSimpleGit(worktreePath);
    try {
      await git.raw(['reset', 'HEAD', '--', ...files]);
    } finally {
      this.invalidateStatusSummaries(worktreePath);
    }
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
    this.invalidateStatusSummaries(worktreePath);
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

      const status = await readWorktreeStatus(worktreePath, git);
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
      this.invalidateStatusSummaries(worktreePath);
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
      this.invalidateStatusSummaries(worktreePath);
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw this.toGitCommandException(error, 'Git commit failed.');
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
      const status = await readWorktreeStatus(worktreePath, git);
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

      const [diff, branchName, log, conventionDocs] = await Promise.all([
        this.getDiff(worktreePath, { staged: true }),
        this.getCurrentBranch(git),
        this.getLog(worktreePath, MAX_COMMIT_MESSAGE_LOG_ENTRIES),
        this.readCommitConventionDocs(worktreePath),
      ]);

      const currentBranch = branchName ?? 'HEAD';
      const compressedStatus = this.buildCompactStatusSummary(stagedFiles);
      const compressedLog = this.buildCompactLog(log);
      const truncatedDiff = this.truncateDiffForPrompt(diff);
      this.logger.log(
        `[commit-message:${requestId}] context loaded branch="${currentBranch}" diffChars=${diff.length} truncatedDiffChars=${truncatedDiff.length} recentCommits=${log.length} conventionDocChars=${conventionDocs.length}`,
      );

      const promptInput = {
        worktreePath,
        branchName: currentBranch,
        files: stagedFiles,
        diff: truncatedDiff,
        compactStatus: compressedStatus,
        compactLog: compressedLog,
        conventionDocs,
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
    const branch = await this.getCurrentBranch(git);
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

  private readonly editorBaselines = new EditorBaselines();

  async show(
    worktreePath: string,
    ref: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!isValidGitRef(ref)) {
      throw new BadRequestException(`Invalid git ref: ${ref}`);
    }

    try {
      const content = await this.editorBaselines.read(
        worktreePath,
        ref,
        path,
        signal,
      );
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

  private toGitCommandException(
    error: any,
    fallback: string,
  ): BadRequestException {
    return new BadRequestException(
      this.extractGitErrorMessage(error) || fallback,
    );
  }

  private extractGitErrorMessage(error: any): string | null {
    const candidates = [
      error?.git?.stdErr,
      error?.stderr,
      error?.message,
      typeof error === 'string' ? error : null,
    ];

    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const normalized = candidate.replace(/\r\n/g, '\n').trim();
      if (normalized) {
        return normalized;
      }
    }

    return null;
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
    files?: FileStatus[],
    version?: string,
    snapshot?: WorktreeStatusFingerprintSnapshot,
  ): Promise<GitScopeSummary> {
    const key = [worktreePath, staged].join('\0');
    const cached = this.scopeStatsCache.get(key);
    if (version && cached?.version === version) return cached.stats;
    const allFiles = files ?? (await this.getStatus(worktreePath));
    const scopeFiles = allFiles.filter((file) => file.staged === staged);
    const diffStats = await this.readNumstat(
      worktreePath,
      staged,
      snapshot?.status,
    );

    let additions = diffStats.additions;
    let deletions = diffStats.deletions;

    if (!staged) {
      const untrackedFiles = scopeFiles.filter(
        (file) => file.status === 'untracked',
      );
      const untrackedStats = await mapWithConcurrency(
        untrackedFiles,
        UNTRACKED_STATS_CONCURRENCY,
        (file) =>
          this.readUntrackedFileStats(
            worktreePath,
            file.path,
            snapshot?.pathVersions.get(file.path),
            snapshot?.pathSizes.get(file.path) ?? undefined,
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

    const stats = { files: scopeFiles.length, additions, deletions };
    if (version) this.scopeStatsCache.set(key, { version, stats });
    return stats;
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

  private async getCurrentBranch(git: SimpleGit): Promise<string | null> {
    return readCurrentBranch(git).catch(() => null);
  }

  // Some repos (large monorepos in particular) scope remote.origin.fetch to a
  // handful of branch prefixes, so most branches never get a local
  // refs/remotes/origin/<branch> ref even after being pushed. ls-remote asks the
  // remote directly only when no local remote ref exists. This is polled every
  // few seconds, so bound network work and briefly cache even failed lookups.
  private readonly remoteBranchShaCache = new Map<
    string,
    { match: RemoteBranchMatch | null; expiresAt: number }
  >();
  private readonly remoteBranchInFlight = new Map<
    string,
    Promise<RemoteBranchMatch | null>
  >();
  private static readonly REMOTE_BRANCH_CACHE_TTL_MS = 90_000;
  private static readonly REMOTE_BRANCH_FAILURE_TTL_MS = 10_000;
  private static readonly REMOTE_BRANCH_CACHE_MAX_ENTRIES = 256;
  private static readonly REMOTE_BRANCH_TIMEOUT_MS = 1_500;

  private async findMatchingRemoteBranch(
    git: SimpleGit,
    worktreePath: string,
    branch: string,
  ): Promise<RemoteBranchMatch | null> {
    if (branch === 'HEAD') return null;

    const remotes: RemoteWithRefs[] = await git
      .getRemotes(true)
      .catch((): RemoteWithRefs[] => []);
    const remote =
      remotes.find((candidate) => candidate.name === 'origin') ?? remotes[0];
    if (!remote) return null;

    const localSha = await git
      .revparse(['--verify', `refs/remotes/${remote.name}/${branch}`])
      .then((value) => value.trim())
      .catch(() => null);
    if (localSha) return { ref: `${remote.name}/${branch}`, sha: localSha };

    const normalizedPath = path.resolve(worktreePath);
    const cacheKey = JSON.stringify([
      normalizedPath,
      remote.name,
      remote.refs.fetch,
      branch,
    ]);
    const cached = this.remoteBranchShaCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.match;
    const existing = this.remoteBranchInFlight.get(cacheKey);
    if (existing) return existing;

    const request = (async () => {
      let sha: string | null = null;
      let ttl = GitService.REMOTE_BRANCH_CACHE_TTL_MS;
      try {
        sha = await this.readRemoteBranchSha(
          normalizedPath,
          remote.name,
          branch,
        );
      } catch {
        ttl = GitService.REMOTE_BRANCH_FAILURE_TTL_MS;
      }
      const match = sha ? { ref: `${remote.name}/${branch}`, sha } : null;
      const now = Date.now();
      for (const [key, entry] of this.remoteBranchShaCache) {
        if (entry.expiresAt <= now) this.remoteBranchShaCache.delete(key);
      }
      this.remoteBranchShaCache.delete(cacheKey);
      while (
        this.remoteBranchShaCache.size >=
        GitService.REMOTE_BRANCH_CACHE_MAX_ENTRIES
      ) {
        this.remoteBranchShaCache.delete(
          this.remoteBranchShaCache.keys().next().value!,
        );
      }
      this.remoteBranchShaCache.set(cacheKey, { match, expiresAt: now + ttl });
      return match;
    })();
    this.remoteBranchInFlight.set(cacheKey, request);
    const cleanup = () => {
      if (this.remoteBranchInFlight.get(cacheKey) === request) {
        this.remoteBranchInFlight.delete(cacheKey);
      }
    };
    void request.then(cleanup, cleanup);
    return request;
  }

  private readRemoteBranchSha(
    worktreePath: string,
    remote: string,
    branch: string,
  ): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const ref = `refs/heads/${branch}`;
      const child = spawn('git', ['ls-remote', '--heads', '--', remote, ref], {
        cwd: worktreePath,
        env: {
          ...buildAugmentedEnv(process.env, worktreePath),
          GIT_TERMINAL_PROMPT: '0',
        },
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: process.platform !== 'win32',
      });
      const output: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const terminate = () => {
        if (process.platform === 'win32' && child.pid) {
          execFile(
            'taskkill',
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, timeout: 1_000 },
            () => child.kill('SIGKILL'),
          );
          return;
        }
        if (process.platform !== 'win32' && child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
            return;
          } catch {
            // The process may already have exited.
          }
        }
        child.kill('SIGKILL');
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
        terminate();
      };
      // An absolute deadline also covers helpers that keep inherited pipes open.
      // Kill the process group on POSIX so ssh/credential helpers do not pile up.
      const timer = setTimeout(() => {
        fail(new Error('Remote branch lookup timed out.'));
      }, GitService.REMOTE_BRANCH_TIMEOUT_MS);
      child.on('error', fail);
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) {
          fail(new Error('Remote branch lookup output exceeded limit.'));
        } else if (!settled) {
          output.push(chunk);
        }
      });
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) return fail(new Error('Remote branch lookup failed.'));
        settled = true;
        clearTimeout(timer);
        const line = Buffer.concat(output)
          .toString('utf8')
          .split('\n')
          .find((line) => {
            const [sha, name] = line.split('\t');
            return name === ref && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha);
          });
        resolve(line?.split('\t')[0] ?? null);
      });
    });
  }

  private async getAheadBehind(
    git: SimpleGit,
    branch: string,
    upstream: string,
    headSha?: string | null,
    upstreamSha?: string | null,
    cacheScope = '',
  ): Promise<{ ahead: number; behind: number }> {
    const pair =
      headSha && upstreamSha
        ? [cacheScope, headSha, upstreamSha].join('\0')
        : null;
    const cached = pair ? this.divergenceCache.get(pair) : null;
    if (cached) return cached;
    try {
      const counts = (
        await git.raw([
          'rev-list',
          '--left-right',
          '--count',
          `${headSha ?? branch}...${upstreamSha ?? upstream}`,
        ])
      ).trim();
      const [aheadCount, behindCount] = counts.split(/\s+/);
      const countsResult = {
        ahead: Number(aheadCount) || 0,
        behind: Number(behindCount) || 0,
      };
      if (pair) this.divergenceCache.set(pair, countsResult);
      return countsResult;
    } catch {
      return { ahead: 0, behind: 0 };
    }
  }

  // Like getAheadBehind, but compares against a remote SHA obtained via ls-remote
  // rather than a local refs/remotes/* ref (which may not exist — see
  // findMatchingRemoteBranch). rev-list still works directly against a raw SHA as
  // long as the commit is reachable locally; if the remote is ahead of what we have
  // (e.g. someone else pushed to this branch), the object may be missing and
  // rev-list fails. Return unknown so callers do not report a fabricated sync.
  private async getAheadBehindBySha(
    git: SimpleGit,
    branch: string,
    remoteSha: string,
    cacheScope = '',
  ): Promise<{ ahead: number; behind: number } | null> {
    const pair = /^[a-f0-9]{40,64}$/.test(branch)
      ? [cacheScope, branch, remoteSha].join('\0')
      : null;
    const cached = pair ? this.divergenceCache.get(pair) : null;
    if (cached) return cached;
    try {
      // A partial clone must not lazily fetch an advertised, missing object
      // outside the bounded remote lookup above.
      const counts = (
        await git
          .env('GIT_NO_LAZY_FETCH', '1')
          .raw([
            'rev-list',
            '--left-right',
            '--count',
            `${branch}...${remoteSha}`,
          ])
      ).trim();
      const [aheadCount, behindCount] = counts.split(/\s+/);
      const result = {
        ahead: Number(aheadCount) || 0,
        behind: Number(behindCount) || 0,
      };
      if (pair) this.divergenceCache.set(pair, result);
      return result;
    } catch {
      return null;
    }
  }

  /**
   * Sums `git diff [--cached] --numstat` for one side of the given status.
   * The status already says which tracked paths changed, so the diff is
   * skipped when that side has none, and is otherwise limited to those paths
   * instead of re-scanning every tracked file (about 2.5x faster on a 450k-file
   * repository). The path list is a superset of what the diff can report,
   * so the totals are unchanged.
   */
  private async readNumstat(
    worktreePath: string,
    staged: boolean,
    status?: StatusResult,
  ): Promise<{ additions: number; deletions: number }> {
    if (status && !hasTrackedChanges(status, staged ? 'staged' : 'unstaged')) {
      return { additions: 0, deletions: 0 };
    }
    const git = scheduledReadGit(
      worktreeSimpleGit(worktreePath, { readOnly: true }),
      worktreePath,
      -5,
    );
    const output = await git.raw([
      'diff',
      ...(staged ? ['--cached'] : []),
      '--numstat',
      '-z',
      '--find-renames',
      '-l200',
      ...((status && verbatimPathspecArgs(trackedStatusPaths(status))) ?? []),
    ]);
    const totals = { additions: 0, deletions: 0 };
    const tokens = output.split('\0');
    for (let index = 0; index < tokens.length; index++) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[index]);
      if (!match) continue;
      if (match[3] === '') index += 2;
      if (match[1] !== '-') totals.additions += Number(match[1]);
      if (match[2] !== '-') totals.deletions += Number(match[2]);
    }
    return totals;
  }

  private async readUntrackedFileStats(
    worktreePath: string,
    relativePath: string,
    version?: string,
    size?: number,
  ): Promise<{ additions: number; deletions: number }> {
    try {
      const stats = await readWorktreeTextStats(
        worktreePath,
        relativePath,
        version,
        size,
      );
      return { additions: stats.binary ? 0 : (stats.lines ?? 0), deletions: 0 };
    } catch {
      return { additions: 0, deletions: 0 };
    }
  }

  private async readCommitConventionDocs(
    worktreePath: string,
  ): Promise<string> {
    const sections = await Promise.all(
      COMMIT_CONVENTION_DOC_FILENAMES.map(async (filename) => {
        try {
          const contents = await readFile(
            path.join(worktreePath, filename),
            'utf8',
          );
          const trimmed = contents.trim();
          if (!trimmed) return null;
          const truncated =
            trimmed.length > MAX_COMMIT_MESSAGE_CONVENTION_DOC_CHARS
              ? `${trimmed.slice(0, MAX_COMMIT_MESSAGE_CONVENTION_DOC_CHARS)}\n\n[truncated]`
              : trimmed;
          return `### ${filename}\n${truncated}`;
        } catch {
          return null;
        }
      }),
    );

    return sections
      .filter((section): section is string => section !== null)
      .join('\n\n');
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

  private async generateCommitMessageWithClaude(
    input: CommitMessagePromptInput,
  ): Promise<CommitMessageSuggestion | null> {
    return this.generateCommitSuggestionWithRetry('claude', (retryHint) =>
      this.textAgentGenerationService.generate({
        provider: 'claude',
        worktreePath: input.worktreePath,
        prompt: this.buildCommitMessagePrompt({ ...input, retryHint }),
        taskName: 'commit-message',
        claude: {
          systemPrompt: COMMIT_MESSAGE_CLAUDE_SYSTEM_PROMPT,
          tools: [],
          settingSources: [],
        },
      }),
    );
  }

  private async generateCommitMessageWithCodex(
    input: CommitMessagePromptInput,
  ): Promise<CommitMessageSuggestion | null> {
    return this.generateCommitSuggestionWithRetry('codex', (retryHint) =>
      this.textAgentGenerationService.generate({
        provider: 'codex',
        worktreePath: input.worktreePath,
        prompt: this.buildCommitMessagePrompt({ ...input, retryHint }),
        taskName: 'commit-message',
      }),
    );
  }

  private async generateCommitMessageWithPi(
    input: CommitMessagePromptInput,
  ): Promise<CommitMessageSuggestion | null> {
    return this.generateCommitSuggestionWithRetry('pi', (retryHint) =>
      this.textAgentGenerationService.generate({
        provider: 'pi',
        worktreePath: input.worktreePath,
        prompt: this.buildCommitMessagePrompt({ ...input, retryHint }),
        taskName: 'commit-message',
      }),
    );
  }

  private async generateCommitSuggestionWithRetry(
    source: CommitMessageSuggestion['source'],
    generate: (
      retryHint?: string,
    ) => Promise<GenerateTextWithAgentResult | null>,
  ): Promise<CommitMessageSuggestion | null> {
    let lastRawText = '';
    let retryHint: string | undefined;
    for (
      let attempt = 1;
      attempt <= COMMIT_MESSAGE_MAX_ATTEMPTS;
      attempt += 1
    ) {
      const result = await generate(retryHint);
      lastRawText = result?.text ?? '';
      const suggestion = this.parseCommitSuggestion(lastRawText, source);
      if (suggestion) {
        return suggestion;
      }
      retryHint = `Your previous response could not be parsed as the required JSON shape. Return exactly one JSON object: {"subject":"...","body":null}.`;
    }

    if (lastRawText.trim()) {
      this.logger.warn(
        `[commit-message] ${source} response could not be parsed after ${COMMIT_MESSAGE_MAX_ATTEMPTS} attempt(s): ${lastRawText.trim()}`,
      );
    }
    return null;
  }

  private generateCommitMessageWithProvider(
    provider: CommitMessageProvider,
    input: CommitMessagePromptInput,
  ): Promise<CommitMessageSuggestion | null> {
    switch (provider) {
      case 'claude':
        return this.generateCommitMessageWithClaude(input);
      case 'codex':
        return this.generateCommitMessageWithCodex(input);
      case 'opencode':
        return this.generateCommitSuggestionWithRetry('opencode', (retryHint) =>
          this.textAgentGenerationService.generate({
            provider: 'opencode',
            worktreePath: input.worktreePath,
            prompt: this.buildCommitMessagePrompt({ ...input, retryHint }),
            taskName: 'commit-message',
          }),
        );
      case 'pi':
        return this.generateCommitMessageWithPi(input);
    }
  }

  private buildCommitMessagePrompt(input: {
    branchName: string;
    compactLog: string;
    compactStatus: string;
    diff: string;
    conventionDocs: string;
    retryHint?: string;
  }): string {
    return [
      'Generate the exact commit message that will be passed to git commit -m.',
      'Your response is machine-read and must be strict JSON only.',
      'Return exactly one JSON object with this shape:',
      '{"subject":"...","body":null}',
      '',
      'Output rules:',
      '- Do not include greetings, explanations, analysis, markdown fences, or extra text.',
      '- Do not return the commit message as plain text.',
      '- Do not include JSON inside subject or body; JSON is only the transport format.',
      '- The subject string is the exact first line that will be committed.',
      '- The body string, when non-null, is the exact commit body after a blank line.',
      '',
      'Follow the project commit style shown in the recent commits below and any',
      'repository convention docs provided.',
      'Match their format, tone, and level of detail.',
      `If no clear convention is detectable, fall back to Conventional Commits (e.g. feat(scope): description), using one of these types: ${CONVENTIONAL_COMMIT_TYPES_EXAMPLE}.`,
      'Describe the semantic change, not the file operations.',
      'Use null for body unless extra context materially helps.',
      ...(input.retryHint ? ['', input.retryHint] : []),
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
      '',
      'Repository convention docs:',
      input.conventionDocs || '- none found',
    ].join('\n');
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

    for (const candidate of this.extractJsonObjectCandidates(normalized)) {
      const parsed = this.parseCommitSuggestionJson(candidate);
      const subject = this.normalizeCommitSubject(parsed?.subject);
      if (!subject) {
        continue;
      }
      const body = parsed?.['body'];

      return {
        subject,
        body: typeof body === 'string' && body.trim() ? body.trim() : null,
        confidence: 'medium',
        source,
      };
    }

    return null;
  }

  private parseCommitSuggestionJson(
    raw: string,
  ): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  private extractJsonObjectCandidates(raw: string): string[] {
    const candidates: string[] = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < raw.length; index += 1) {
      const char = raw[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{') {
        if (depth === 0) {
          start = index;
        }
        depth += 1;
        continue;
      }

      if (char === '}' && depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          candidates.push(raw.slice(start, index + 1));
          start = -1;
        }
      }
    }

    return candidates;
  }

  private normalizeCommitSubject(subject: unknown): string | null {
    if (typeof subject !== 'string') {
      return null;
    }

    const normalized = subject.trim().replace(/\s+/g, ' ');
    if (!normalized || normalized.length > MAX_COMMIT_SUBJECT_LENGTH) {
      return null;
    }

    return normalized;
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

  private normalizeCommitMessageProvider(
    provider: AgentProviderId | undefined,
  ): CommitMessageProvider {
    if (
      provider === 'claude' ||
      provider === 'codex' ||
      provider === 'pi' ||
      provider === 'opencode'
    ) {
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

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, values.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await mapper(values[index]);
      }
    }),
  );

  return results;
}
