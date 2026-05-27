import { BadRequestException, Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { SimpleGit, StatusResult } from 'simple-git';

import {
  buildAugmentedEnv,
  worktreeSimpleGit,
} from '../config/system-paths.js';
import {
  ChangeReviewContextWindow,
  ChangeReviewContextRange,
  ChangeReviewFileStatus,
  ChangeReviewFileSummary,
  ChangeReviewFileWindow,
  ChangeReviewLoadGuard,
  ChangeReviewPullRequestInfo,
  ChangeReviewRow,
  ChangeReviewScope,
  ChangeReviewSummary,
} from './change-review.types.js';
import {
  clearWorktreeFingerprintCache,
  readWorktreeFingerprint,
  readWorktreeStatusSnapshot,
} from './git-worktree-fingerprint.js';

const DEFAULT_CHANGE_REVIEW_FILE_LIMIT = 2_000;
const LARGE_FILE_BYTES = 1_000_000;
const LARGE_FILE_LINES = 25_000;
const DEFAULT_CONTEXT = 8;
const DEFAULT_LIMIT = 400;
const DEFAULT_CONTEXT_RANGE_LIMIT = 120;
const MAX_LIMIT = 1_500;
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1_000;
const STALE_ORIGIN_SECONDS = 24 * 60 * 60;
const FILE_SUMMARY_CONCURRENCY = 32;
const UNTRACKED_SUMMARY_CONCURRENCY = 16;
const LAST_COMMIT_WORKTREE_FINGERPRINT = '0'.repeat(64);

interface ReviewBase {
  repoRoot: string;
  branch: string;
  baseRef: string | null;
  baseSha: string | null;
  headSha: string | null;
  mergeBaseSha: string | null;
  compareLabel: string;
  originRefAgeSeconds: number | null;
  staleBase: boolean;
  pullRequest: ChangeReviewPullRequestInfo | null;
}

interface CachedRows {
  key: string;
  createdAt: number;
  rows: ChangeReviewRow[];
  contextRanges: ChangeReviewContextRange[];
  message: string | null;
  binary: boolean;
  large: boolean;
  truncated: boolean;
  changeHash: string;
}

interface CachedFileSummaries {
  key: string;
  createdAt: number;
  summaries: FileSummarySet;
}

interface CachedBase {
  key: string;
  createdAt: number;
  base: ReviewBase;
}

interface CachedFileLines {
  key: string;
  createdAt: number;
  lines: {
    oldLines: string[];
    newLines: string[];
  };
}

interface CachedContextWindow {
  key: string;
  createdAt: number;
  window: ChangeReviewContextWindow;
}

interface WorktreeReviewState {
  fingerprint: string;
  status: StatusResult | null;
}

interface ChangeReviewLoadCheck {
  guard: ChangeReviewLoadGuard | null;
  status: StatusResult | null;
}

interface WorktreeChangeCounts {
  totalFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  conflictedFiles: number;
}

interface FileSummarySet {
  files: ChangeReviewFileSummary[];
  untrackedPaths: ReadonlySet<string>;
}

interface FileSummaryLookup {
  summary: ChangeReviewFileSummary;
  untracked: boolean;
}

@Injectable()
export class ChangeReviewService {
  private readonly baseCache = new Map<string, CachedBase>();
  private readonly summaryCache = new Map<string, CachedFileSummaries>();
  private readonly rowCache = new Map<string, CachedRows>();
  private readonly fileLinesCache = new Map<string, CachedFileLines>();
  private readonly contextWindowCache = new Map<string, CachedContextWindow>();
  private readonly summaryBuilds = new Map<string, Promise<FileSummarySet>>();
  private readonly rowBuilds = new Map<string, Promise<CachedRows>>();

  async getSummary(
    worktreePath: string,
    scope: ChangeReviewScope,
    refreshBase = false,
    forceLoad = false,
  ): Promise<ChangeReviewSummary> {
    this.assertScope(scope);
    if (refreshBase) {
      this.clearScopeCache(worktreePath, scope);
      clearWorktreeFingerprintCache(worktreePath);
    }
    const git = worktreeSimpleGit(worktreePath);
    const base = await this.resolveBase(git, worktreePath, scope, refreshBase);
    const loadCheck = await this.readLoadCheck(
      git,
      worktreePath,
      scope,
      base,
      forceLoad,
    );
    if (loadCheck.guard?.blocked) {
      return this.buildGuardedSummary(
        worktreePath,
        scope,
        base,
        loadCheck.guard,
      );
    }

    const worktreeState = await this.readWorktreeReviewState(
      git,
      worktreePath,
      scope,
      true,
      loadCheck.status,
    );
    const summaries = await this.readFileSummaries(
      git,
      worktreePath,
      scope,
      base,
      worktreeState,
    );
    const files = summaries.files;

    return {
      scope,
      worktreePath,
      repoRoot: base.repoRoot,
      branch: base.branch,
      baseRef: base.baseRef,
      baseSha: base.baseSha,
      headSha: base.headSha,
      worktreeFingerprint: worktreeState.fingerprint,
      mergeBaseSha: base.mergeBaseSha,
      compareLabel: base.compareLabel,
      generatedAt: new Date().toISOString(),
      staleBase: base.staleBase,
      originRefAgeSeconds: base.originRefAgeSeconds,
      pullRequest: base.pullRequest,
      totals: {
        files: files.length,
        additions: files.reduce((sum, file) => sum + file.additions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      },
      files,
      loadGuard: loadCheck.guard,
    };
  }

  async getFileWindow(
    worktreePath: string,
    scope: ChangeReviewScope,
    filePath: string,
    options: {
      offset?: number;
      limit?: number;
      context?: number;
      forceLoad?: boolean;
      forceFileLoad?: boolean;
    } = {},
  ): Promise<ChangeReviewFileWindow> {
    this.assertScope(scope);
    const offset = Math.max(0, Number(options.offset) || 0);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(options.limit) || DEFAULT_LIMIT),
    );
    const context = Math.max(
      0,
      Math.min(200, Number(options.context) || DEFAULT_CONTEXT),
    );

    const git = worktreeSimpleGit(worktreePath);
    const base = await this.resolveBase(git, worktreePath, scope, false);
    const loadCheck = await this.readLoadCheck(
      git,
      worktreePath,
      scope,
      base,
      Boolean(options.forceLoad),
    );
    if (loadCheck.guard?.blocked) {
      throw new BadRequestException(this.loadGuardMessage(loadCheck.guard));
    }

    const worktreeState = await this.readWorktreeReviewState(
      git,
      worktreePath,
      scope,
      false,
      loadCheck.status,
    );
    const lookup = await this.readFileSummary(
      git,
      worktreePath,
      scope,
      base,
      filePath,
      worktreeState,
    );
    const summary = lookup.summary;
    const cacheKey = [
      worktreePath,
      scope,
      base.mergeBaseSha ?? base.baseSha ?? '',
      base.headSha ?? '',
      scope === 'last-commit' ? '' : worktreeState.fingerprint,
      filePath,
      context,
      options.forceFileLoad ? 'force-file' : 'guarded-file',
      summary.additions,
      summary.deletions,
      summary.status,
    ].join('\0');
    const full = await this.getOrBuildRows(
      cacheKey,
      git,
      worktreePath,
      scope,
      base,
      lookup,
      context,
      worktreeState.fingerprint,
      Boolean(options.forceFileLoad),
    );
    const rows = full.rows.slice(offset, offset + limit);

    return {
      scope,
      path: summary.path,
      oldPath: summary.oldPath,
      status: summary.status,
      binary: full.binary,
      large: full.large,
      truncated: full.truncated,
      message: full.message,
      offset,
      limit,
      totalRows: full.rows.length,
      hasMore: offset + rows.length < full.rows.length,
      context,
      changeHash: full.changeHash,
      rows,
      contextRanges: full.contextRanges,
    };
  }

  async getContextWindow(
    worktreePath: string,
    scope: ChangeReviewScope,
    filePath: string,
    range: {
      oldStart: number;
      newStart: number;
      count: number;
      limit?: number;
      forceLoad?: boolean;
      forceFileLoad?: boolean;
    },
  ): Promise<ChangeReviewContextWindow> {
    this.assertScope(scope);
    const oldStart = Math.max(1, Number(range.oldStart) || 1);
    const newStart = Math.max(1, Number(range.newStart) || 1);
    const count = Math.max(0, Number(range.count) || 0);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(range.limit) || DEFAULT_CONTEXT_RANGE_LIMIT),
    );

    const git = worktreeSimpleGit(worktreePath);
    const base = await this.resolveBase(git, worktreePath, scope, false);
    const loadCheck = await this.readLoadCheck(
      git,
      worktreePath,
      scope,
      base,
      Boolean(range.forceLoad),
    );
    if (loadCheck.guard?.blocked) {
      throw new BadRequestException(this.loadGuardMessage(loadCheck.guard));
    }

    const worktreeState = await this.readWorktreeReviewState(
      git,
      worktreePath,
      scope,
      false,
      loadCheck.status,
    );
    const { summary } = await this.readFileSummary(
      git,
      worktreePath,
      scope,
      base,
      filePath,
      worktreeState,
    );
    const contextCacheKey = [
      worktreePath,
      scope,
      base.mergeBaseSha ?? base.baseSha ?? '',
      base.headSha ?? '',
      scope === 'last-commit' ? '' : worktreeState.fingerprint,
      filePath,
      oldStart,
      newStart,
      count,
      limit,
      range.forceFileLoad ? 'force-file' : 'guarded-file',
      summary.additions,
      summary.deletions,
      summary.status,
    ].join('\0');
    const cached = this.getCachedContextWindow(contextCacheKey);
    if (cached) return cached;

    const fileLines = await this.readReviewFileLines(
      git,
      worktreePath,
      scope,
      base,
      summary,
      worktreeState.fingerprint,
    );
    const rows = this.buildContextRows(
      summary.path,
      fileLines,
      oldStart,
      newStart,
      Math.min(count, limit),
    );

    return this.cachedContextWindow(contextCacheKey, {
      scope,
      path: summary.path,
      oldStart,
      newStart,
      count,
      limit,
      rows,
    });
  }

  private async resolveBase(
    git: SimpleGit,
    worktreePath: string,
    scope: ChangeReviewScope,
    refreshBase: boolean,
  ): Promise<ReviewBase> {
    const cacheKey = [worktreePath, scope, 'base'].join('\0');
    const cached = refreshBase ? null : this.getCachedBase(cacheKey);
    if (cached) return cached;

    const [repoRoot, branchSummary, headSha] = await Promise.all([
      git.revparse(['--show-toplevel']).then((value) => value.trim()),
      git.branchLocal(),
      git
        .revparse(['HEAD'])
        .then((value) => value.trim())
        .catch(() => null),
    ]);
    const branch = branchSummary.current || 'HEAD';
    const pullRequest = await this.readPullRequestInfo(repoRoot, branch);
    let baseRef: string | null = null;
    let baseSha: string | null = null;
    let mergeBaseSha: string | null = null;
    let compareLabel = 'Working tree';
    let originRefAgeSeconds: number | null = null;

    if (scope === 'last-commit') {
      baseSha = await git
        .revparse(['HEAD^'])
        .then((value) => value.trim())
        .catch(() => null);
      compareLabel = 'Last commit';
    } else if (scope === 'uncommitted') {
      baseRef = 'HEAD';
      baseSha = headSha;
      mergeBaseSha = headSha;
      compareLabel = 'Uncommitted changes';
    } else {
      if (refreshBase) {
        await this.refreshLikelyBase(
          git,
          repoRoot,
          pullRequest?.baseRefName ?? null,
        );
      }
      baseRef = await this.detectBaseRef(git, pullRequest?.baseRefName ?? null);
      baseSha = baseRef
        ? await git
            .revparse([baseRef])
            .then((value) => value.trim())
            .catch(() => null)
        : null;
      mergeBaseSha = baseRef
        ? await git
            .raw(['merge-base', 'HEAD', baseRef])
            .then((value) => value.trim())
            .catch(() => baseSha)
        : headSha;
      originRefAgeSeconds = baseRef
        ? await this.readRefAgeSeconds(git, baseRef)
        : null;
      compareLabel = baseRef ? `${branch} vs ${baseRef}` : `${branch} vs HEAD`;
    }

    return this.cachedBase(cacheKey, {
      repoRoot,
      branch,
      baseRef,
      baseSha,
      headSha,
      mergeBaseSha,
      compareLabel,
      originRefAgeSeconds,
      staleBase:
        originRefAgeSeconds !== null &&
        originRefAgeSeconds > STALE_ORIGIN_SECONDS,
      pullRequest,
    });
  }

  private async readFileSummaries(
    git: SimpleGit,
    worktreePath: string,
    scope: ChangeReviewScope,
    base: ReviewBase,
    worktreeState: WorktreeReviewState,
  ): Promise<FileSummarySet> {
    const cacheKey = [
      worktreePath,
      scope,
      base.mergeBaseSha ?? base.baseSha ?? '',
      base.headSha ?? '',
      scope === 'last-commit' ? '' : worktreeState.fingerprint,
      'summary',
    ].join('\0');
    const cached = this.getCachedFileSummaries(cacheKey);
    if (cached) return cached;

    const inFlight = this.summaryBuilds.get(cacheKey);
    if (inFlight) return inFlight;

    const promise = this.buildFileSummaries(
      git,
      worktreePath,
      scope,
      base,
      worktreeState,
      cacheKey,
    ).finally(() => {
      this.summaryBuilds.delete(cacheKey);
    });
    this.summaryBuilds.set(cacheKey, promise);
    return promise;
  }

  private async buildFileSummaries(
    git: SimpleGit,
    worktreePath: string,
    scope: ChangeReviewScope,
    base: ReviewBase,
    worktreeState: WorktreeReviewState,
    cacheKey: string,
  ): Promise<FileSummarySet> {
    const [statusOutput, numstatOutput] = await Promise.all([
      git.raw(
        this.buildDiffArgs(scope, base, [
          '--name-status',
          '-z',
          '--find-renames',
        ]),
      ),
      git.raw(
        this.buildDiffArgs(scope, base, ['--numstat', '-z', '--find-renames']),
      ),
    ]);
    const stats = this.parseNumstat(numstatOutput);
    const untrackedPaths = new Set<string>();
    const tracked: ChangeReviewFileSummary[] = await mapWithConcurrency(
      this.parseNameStatus(statusOutput),
      FILE_SUMMARY_CONCURRENCY,
      async (file) => {
        const stat = stats.get(file.path) ??
          stats.get(file.oldPath ?? '') ?? {
            additions: 0,
            deletions: 0,
            binary: false,
          };
        const size = await this.readCurrentFileSize(worktreePath, file.path);
        return {
          ...file,
          additions: stat.additions,
          deletions: stat.deletions,
          binary: stat.binary,
          large:
            stat.additions + stat.deletions > LARGE_FILE_LINES ||
            (size !== null && size > LARGE_FILE_BYTES),
          size,
        };
      },
    );

    if (scope !== 'last-commit' && worktreeState.status) {
      const untracked = await this.readUntrackedSummaries(
        worktreePath,
        worktreeState.status.not_added,
      );
      const seen = new Set(tracked.map((file) => file.path));
      for (const file of untracked) {
        if (!seen.has(file.path)) {
          tracked.push(file);
          untrackedPaths.add(file.path);
        }
      }
    }

    return this.cachedFileSummaries(cacheKey, {
      files: tracked.sort((left, right) => left.path.localeCompare(right.path)),
      untrackedPaths,
    });
  }

  private async readLoadCheck(
    git: SimpleGit,
    worktreePath: string,
    scope: ChangeReviewScope,
    base: ReviewBase,
    forceLoad: boolean,
  ): Promise<ChangeReviewLoadCheck> {
    if (forceLoad) {
      return { guard: null, status: null };
    }

    const status = scope === 'last-commit' ? null : await git.status();
    const worktreeCounts = status
      ? this.countWorktreeChanges(status)
      : {
          totalFiles: 0,
          stagedFiles: 0,
          unstagedFiles: 0,
          conflictedFiles: 0,
        };

    if (worktreeCounts.totalFiles > DEFAULT_CHANGE_REVIEW_FILE_LIMIT) {
      return {
        status,
        guard: {
          blocked: true,
          threshold: DEFAULT_CHANGE_REVIEW_FILE_LIMIT,
          totalFiles: worktreeCounts.totalFiles,
          stagedFiles: worktreeCounts.stagedFiles,
          unstagedFiles: worktreeCounts.unstagedFiles,
          conflictedFiles: worktreeCounts.conflictedFiles,
          reason: 'worktree',
        },
      };
    }

    const scopedFiles =
      scope === 'uncommitted'
        ? worktreeCounts.totalFiles
        : await this.countScopedFiles(git, scope, base, status);
    if (scopedFiles > DEFAULT_CHANGE_REVIEW_FILE_LIMIT) {
      return {
        status,
        guard: {
          blocked: true,
          threshold: DEFAULT_CHANGE_REVIEW_FILE_LIMIT,
          totalFiles: scopedFiles,
          stagedFiles: worktreeCounts.stagedFiles,
          unstagedFiles: worktreeCounts.unstagedFiles,
          conflictedFiles: worktreeCounts.conflictedFiles,
          reason: 'scope',
        },
      };
    }

    return { guard: null, status };
  }

  private countWorktreeChanges(status: StatusResult): WorktreeChangeCounts {
    const conflictedPaths = new Set(status.conflicted);
    const stagedPaths = new Set<string>();
    const unstagedPaths = new Set<string>();
    const allPaths = new Set<string>(status.conflicted);

    for (const file of status.files) {
      const filePath = file.path;
      allPaths.add(filePath);
      if (conflictedPaths.has(filePath)) continue;
      if (file.index && file.index !== ' ' && file.index !== '?') {
        stagedPaths.add(filePath);
      }
      if (file.working_dir && file.working_dir !== ' ') {
        unstagedPaths.add(filePath);
      }
    }

    for (const file of status.renamed) {
      allPaths.add(file.to);
      if (!conflictedPaths.has(file.to)) {
        stagedPaths.add(file.to);
      }
    }
    for (const filePath of status.staged) {
      allPaths.add(filePath);
      if (!conflictedPaths.has(filePath)) {
        stagedPaths.add(filePath);
      }
    }
    for (const filePath of [
      ...status.modified,
      ...status.deleted,
      ...status.not_added,
    ]) {
      allPaths.add(filePath);
      if (!conflictedPaths.has(filePath)) {
        unstagedPaths.add(filePath);
      }
    }

    return {
      totalFiles: allPaths.size,
      stagedFiles: stagedPaths.size,
      unstagedFiles: unstagedPaths.size,
      conflictedFiles: conflictedPaths.size,
    };
  }

  private async countScopedFiles(
    git: SimpleGit,
    scope: ChangeReviewScope,
    base: ReviewBase,
    status: StatusResult | null,
  ): Promise<number> {
    const output = await git
      .raw(
        this.buildDiffArgs(scope, base, [
          '--name-status',
          '-z',
          '--find-renames',
        ]),
      )
      .catch(() => '');
    const paths = new Set(
      this.parseNameStatus(output).map((file) => file.path),
    );
    if (scope !== 'last-commit' && status) {
      for (const filePath of status.not_added) {
        paths.add(filePath);
      }
    }
    return paths.size;
  }

  private buildGuardedSummary(
    worktreePath: string,
    scope: ChangeReviewScope,
    base: ReviewBase,
    guard: ChangeReviewLoadGuard,
  ): ChangeReviewSummary {
    return {
      scope,
      worktreePath,
      repoRoot: base.repoRoot,
      branch: base.branch,
      baseRef: base.baseRef,
      baseSha: base.baseSha,
      headSha: base.headSha,
      worktreeFingerprint:
        scope === 'last-commit'
          ? LAST_COMMIT_WORKTREE_FINGERPRINT
          : 'large-change-set',
      mergeBaseSha: base.mergeBaseSha,
      compareLabel: base.compareLabel,
      generatedAt: new Date().toISOString(),
      staleBase: base.staleBase,
      originRefAgeSeconds: base.originRefAgeSeconds,
      pullRequest: base.pullRequest,
      totals: {
        files: guard.totalFiles,
        additions: 0,
        deletions: 0,
      },
      files: [],
      loadGuard: guard,
    };
  }

  private loadGuardMessage(guard: ChangeReviewLoadGuard): string {
    return `Diff loading is paused because this scope has ${guard.totalFiles} changed files. Load the summary with forceLoad=true to continue.`;
  }

  private async readFileSummary(
    git: SimpleGit,
    worktreePath: string,
    scope: ChangeReviewScope,
    base: ReviewBase,
    filePath: string,
    worktreeState: WorktreeReviewState,
  ): Promise<FileSummaryLookup> {
    const summaries = await this.readFileSummaries(
      git,
      worktreePath,
      scope,
      base,
      worktreeState,
    );
    const summary = summaries.files.find(
      (file) => file.path === filePath || file.oldPath === filePath,
    );
    if (!summary) {
      throw new BadRequestException(
        `File is not changed in this scope: ${filePath}`,
      );
    }
    return {
      summary,
      untracked: summaries.untrackedPaths.has(summary.path),
    };
  }

  private async getOrBuildRows(
    cacheKey: string,
    git: SimpleGit,
    worktreePath: string,
    scope: ChangeReviewScope,
    base: ReviewBase,
    lookup: FileSummaryLookup,
    context: number,
    worktreeFingerprint: string,
    forceFileLoad: boolean,
  ): Promise<CachedRows> {
    const cached = this.getCachedRows(cacheKey);
    if (cached) return cached;

    const inFlight = this.rowBuilds.get(cacheKey);
    if (inFlight) return inFlight;

    const promise = this.buildRows(
      git,
      worktreePath,
      scope,
      base,
      lookup,
      context,
      cacheKey,
      worktreeFingerprint,
      forceFileLoad,
    ).finally(() => {
      this.rowBuilds.delete(cacheKey);
    });
    this.rowBuilds.set(cacheKey, promise);
    return promise;
  }

  private async buildRows(
    git: SimpleGit,
    worktreePath: string,
    scope: ChangeReviewScope,
    base: ReviewBase,
    lookup: FileSummaryLookup,
    context: number,
    cacheKey: string,
    worktreeFingerprint: string,
    forceFileLoad: boolean,
  ): Promise<CachedRows> {
    let result: CachedRows;
    const summary = lookup.summary;

    if (summary.binary) {
      result = this.cached(cacheKey, {
        rows: [this.metaRow(summary.path, 'Binary file changed')],
        contextRanges: [],
        message: 'Binary file changed.',
        binary: true,
        large: false,
        truncated: false,
      });
      return result;
    }

    if (summary.large && !forceFileLoad) {
      result = this.cached(cacheKey, {
        rows: [
          this.metaRow(summary.path, 'Large file diff is hidden by default.'),
        ],
        contextRanges: [],
        message: 'Large file diff omitted from automatic rendering.',
        binary: false,
        large: true,
        truncated: true,
      });
      return result;
    }

    if (summary.status === 'added' && lookup.untracked) {
      result = await this.buildUntrackedRows(
        worktreePath,
        summary,
        cacheKey,
        forceFileLoad,
      );
      return result;
    }

    const patch = await git.raw([
      ...this.buildDiffArgs(scope, base, [
        `--unified=${context}`,
        '--find-renames',
      ]),
      '--',
      summary.path,
    ]);
    const fileLines = await this.readReviewFileLines(
      git,
      worktreePath,
      scope,
      base,
      summary,
      worktreeFingerprint,
    );
    const parsed = this.parsePatchRows(summary.path, patch, fileLines);
    result = this.cached(cacheKey, {
      rows: parsed.rows.length
        ? parsed.rows
        : [this.metaRow(summary.path, 'No textual diff for this file.')],
      contextRanges: parsed.contextRanges,
      message: null,
      binary: false,
      large: false,
      truncated: false,
    });
    return result;
  }

  private buildDiffArgs(
    scope: ChangeReviewScope,
    base: ReviewBase,
    flags: string[],
  ): string[] {
    if (scope === 'last-commit') {
      return [
        'diff-tree',
        '--root',
        '--no-commit-id',
        '-r',
        ...flags,
        base.headSha ?? 'HEAD',
      ];
    }
    const ref =
      scope === 'branch'
        ? (base.mergeBaseSha ?? base.baseSha ?? 'HEAD')
        : 'HEAD';
    return ['diff', ...flags, ref];
  }

  private async readWorktreeReviewState(
    git: SimpleGit,
    worktreePath: string,
    scope: ChangeReviewScope,
    validateCached = false,
    knownStatus: StatusResult | null = null,
  ): Promise<WorktreeReviewState> {
    if (scope === 'last-commit') {
      return {
        fingerprint: LAST_COMMIT_WORKTREE_FINGERPRINT,
        status: null,
      };
    }

    if (knownStatus) {
      return {
        fingerprint: await readWorktreeFingerprint(
          worktreePath,
          git,
          knownStatus,
        ),
        status: knownStatus,
      };
    }

    const snapshot = await readWorktreeStatusSnapshot(worktreePath, git, {
      validateCached,
    });
    return {
      fingerprint: snapshot.fingerprint,
      status: snapshot.status,
    };
  }

  private parseNameStatus(
    output: string,
  ): Array<Pick<ChangeReviewFileSummary, 'path' | 'oldPath' | 'status'>> {
    const tokens = output.split('\0').filter(Boolean);
    const files: Array<
      Pick<ChangeReviewFileSummary, 'path' | 'oldPath' | 'status'>
    > = [];
    for (let index = 0; index < tokens.length; ) {
      const rawStatus = tokens[index++] ?? '';
      if (rawStatus.startsWith('R')) {
        const oldPath = tokens[index++] ?? '';
        const nextPath = tokens[index++] ?? oldPath;
        files.push({ path: nextPath, oldPath, status: 'renamed' });
        continue;
      }
      const filePath = tokens[index++] ?? '';
      files.push({
        path: filePath,
        oldPath: null,
        status: this.toFileStatus(rawStatus),
      });
    }
    return files;
  }

  private parseNumstat(
    output: string,
  ): Map<string, { additions: number; deletions: number; binary: boolean }> {
    const tokens = output.split('\0').filter(Boolean);
    const stats = new Map<
      string,
      { additions: number; deletions: number; binary: boolean }
    >();
    for (let index = 0; index < tokens.length; index += 1) {
      const parts = tokens[index].split('\t');
      if (parts.length >= 3) {
        const [additions, deletions, filePath] = parts;
        stats.set(filePath, {
          additions:
            additions === '-' ? 0 : Number.parseInt(additions, 10) || 0,
          deletions:
            deletions === '-' ? 0 : Number.parseInt(deletions, 10) || 0,
          binary: additions === '-' || deletions === '-',
        });
        continue;
      }
      if (parts.length === 2 && index + 2 < tokens.length) {
        const [additions, deletions] = parts;
        const oldPath = tokens[++index];
        const nextPath = tokens[++index];
        const stat = {
          additions:
            additions === '-' ? 0 : Number.parseInt(additions, 10) || 0,
          deletions:
            deletions === '-' ? 0 : Number.parseInt(deletions, 10) || 0,
          binary: additions === '-' || deletions === '-',
        };
        stats.set(nextPath, stat);
        stats.set(oldPath, stat);
      }
    }
    return stats;
  }

  private parsePatchRows(
    filePath: string,
    patch: string,
    fileLines: { oldLines: string[]; newLines: string[] },
  ): { rows: ChangeReviewRow[]; contextRanges: ChangeReviewContextRange[] } {
    const lines = patch.split('\n');
    const rows: ChangeReviewRow[] = [];
    const contextRanges: ChangeReviewContextRange[] = [];
    let oldLine: number | null = null;
    let newLine: number | null = null;
    let previousOldEnd = 0;
    let previousNewEnd = 0;
    let rowIndex = 0;

    for (const line of lines) {
      if (
        !line ||
        line.startsWith('diff --git') ||
        line.startsWith('index ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('new file mode') ||
        line.startsWith('deleted file mode') ||
        line.startsWith('similarity index') ||
        line.startsWith('rename from') ||
        line.startsWith('rename to')
      ) {
        continue;
      }
      if (line.startsWith('@@')) {
        const match = line.match(
          /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/,
        );
        if (match) {
          const nextOld = Number(match[1]);
          const oldCount = Number(match[2] ?? '1');
          const nextNew = Number(match[3]);
          const newCount = Number(match[4] ?? '1');
          const gap =
            Math.min(nextOld - previousOldEnd, nextNew - previousNewEnd) - 1;
          if (gap > 0) {
            const range = {
              id: `${filePath}:gap:${contextRanges.length}`,
              oldStart: previousOldEnd + 1,
              newStart: previousNewEnd + 1,
              count: gap,
            };
            contextRanges.push(range);
            rows.push({
              id: `${filePath}:${rowIndex++}`,
              type: 'expand',
              oldLine: null,
              newLine: null,
              content: `${gap} unchanged line${gap === 1 ? '' : 's'}`,
              path: filePath,
              oldStart: range.oldStart,
              newStart: range.newStart,
              count: range.count,
            });
          }
          oldLine = nextOld;
          newLine = nextNew;
          previousOldEnd = nextOld + oldCount - 1;
          previousNewEnd = nextNew + newCount - 1;
        }
        rows.push({
          id: `${filePath}:${rowIndex++}`,
          type: 'hunk',
          oldLine: null,
          newLine: null,
          content: line,
          path: filePath,
        });
        continue;
      }
      if (line.startsWith('\\')) {
        continue;
      }
      if (line.startsWith('+')) {
        rows.push({
          id: `${filePath}:${rowIndex++}`,
          type: 'add',
          oldLine: null,
          newLine,
          content: line.slice(1),
          path: filePath,
        });
        if (newLine !== null) newLine += 1;
        continue;
      }
      if (line.startsWith('-')) {
        rows.push({
          id: `${filePath}:${rowIndex++}`,
          type: 'delete',
          oldLine,
          newLine: null,
          content: line.slice(1),
          path: filePath,
        });
        if (oldLine !== null) oldLine += 1;
        continue;
      }
      rows.push({
        id: `${filePath}:${rowIndex++}`,
        type: 'context',
        oldLine,
        newLine,
        content: line.startsWith(' ') ? line.slice(1) : line,
        path: filePath,
      });
      if (oldLine !== null) oldLine += 1;
      if (newLine !== null) newLine += 1;
    }

    const trailingGap = Math.min(
      fileLines.oldLines.length - previousOldEnd,
      fileLines.newLines.length - previousNewEnd,
    );
    if (previousOldEnd > 0 && trailingGap > 0) {
      const range = {
        id: `${filePath}:gap:${contextRanges.length}`,
        oldStart: previousOldEnd + 1,
        newStart: previousNewEnd + 1,
        count: trailingGap,
      };
      contextRanges.push(range);
      rows.push({
        id: `${filePath}:${rowIndex++}`,
        type: 'expand',
        oldLine: null,
        newLine: null,
        content: `${trailingGap} unchanged line${trailingGap === 1 ? '' : 's'}`,
        path: filePath,
        oldStart: range.oldStart,
        newStart: range.newStart,
        count: range.count,
      });
    }

    return { rows, contextRanges };
  }

  private buildContextRows(
    filePath: string,
    fileLines: { oldLines: string[]; newLines: string[] },
    oldStart: number,
    newStart: number,
    count: number,
  ): ChangeReviewRow[] {
    const rows: ChangeReviewRow[] = [];
    for (let index = 0; index < count; index += 1) {
      const oldLine = oldStart + index;
      const newLine = newStart + index;
      const content =
        fileLines.newLines[newLine - 1] ??
        fileLines.oldLines[oldLine - 1] ??
        '';
      rows.push({
        id: `${filePath}:context:${oldLine}:${newLine}`,
        type: 'context',
        oldLine,
        newLine,
        content,
        path: filePath,
      });
    }
    return rows;
  }

  private async readReviewFileLines(
    git: SimpleGit,
    worktreePath: string,
    scope: ChangeReviewScope,
    base: ReviewBase,
    summary: ChangeReviewFileSummary,
    worktreeFingerprint: string,
  ): Promise<{ oldLines: string[]; newLines: string[] }> {
    const cacheKey = [
      worktreePath,
      scope,
      base.mergeBaseSha ?? base.baseSha ?? '',
      base.headSha ?? '',
      scope === 'last-commit' ? '' : worktreeFingerprint,
      summary.oldPath ?? '',
      summary.path,
      summary.status,
      summary.additions,
      summary.deletions,
      'lines',
    ].join('\0');
    const cached = this.getCachedFileLines(cacheKey);
    if (cached) return cached;

    const oldRef =
      scope === 'last-commit'
        ? (base.baseSha ?? 'HEAD^')
        : scope === 'branch'
          ? (base.mergeBaseSha ?? base.baseSha ?? 'HEAD')
          : 'HEAD';
    const newRef = scope === 'last-commit' ? (base.headSha ?? 'HEAD') : null;
    const oldPath = summary.oldPath ?? summary.path;

    const [oldText, newText] = await Promise.all([
      summary.status === 'added'
        ? Promise.resolve('')
        : this.readGitFile(git, oldRef, oldPath),
      summary.status === 'deleted'
        ? Promise.resolve('')
        : newRef
          ? this.readGitFile(git, newRef, summary.path)
          : this.readWorktreeFile(worktreePath, summary.path),
    ]);

    return this.cachedFileLines(cacheKey, {
      oldLines: this.splitFileLines(oldText),
      newLines: this.splitFileLines(newText),
    });
  }

  private async readGitFile(
    git: SimpleGit,
    ref: string,
    filePath: string,
  ): Promise<string> {
    return git.raw(['show', `${ref}:${filePath}`]).catch(() => '');
  }

  private async readWorktreeFile(
    worktreePath: string,
    filePath: string,
  ): Promise<string> {
    return fs
      .readFile(path.join(worktreePath, filePath), 'utf8')
      .catch(() => '');
  }

  private splitFileLines(text: string): string[] {
    if (!text) return [];
    const lines = text.split(/\r?\n/);
    if (text.endsWith('\n')) {
      lines.pop();
    }
    return lines;
  }

  private async buildUntrackedRows(
    worktreePath: string,
    summary: ChangeReviewFileSummary,
    cacheKey: string,
    forceFileLoad: boolean,
  ): Promise<CachedRows> {
    const absolutePath = path.join(worktreePath, summary.path);
    const stat = await fs.stat(absolutePath);
    if (stat.size > LARGE_FILE_BYTES && !forceFileLoad) {
      return this.cached(cacheKey, {
        rows: [
          this.metaRow(
            summary.path,
            'Large untracked file omitted from automatic rendering.',
          ),
        ],
        contextRanges: [],
        message: 'Large untracked file omitted from automatic rendering.',
        binary: false,
        large: true,
        truncated: true,
      });
    }
    const buffer = await fs.readFile(absolutePath);
    if (buffer.includes(0)) {
      return this.cached(cacheKey, {
        rows: [this.metaRow(summary.path, 'Binary file changed')],
        contextRanges: [],
        message: 'Binary file changed.',
        binary: true,
        large: false,
        truncated: false,
      });
    }
    const text = buffer.toString('utf8');
    const lines = text.split('\n');
    const truncated = lines.length > LARGE_FILE_LINES;
    const visible = truncated ? lines.slice(0, LARGE_FILE_LINES) : lines;
    const rows: ChangeReviewRow[] = [
      {
        id: `${summary.path}:hunk`,
        type: 'hunk',
        oldLine: null,
        newLine: null,
        content: `@@ -0,0 +1,${visible.length} @@`,
        path: summary.path,
      },
      ...visible.map((line, index) => ({
        id: `${summary.path}:${index}`,
        type: 'add' as const,
        oldLine: null,
        newLine: index + 1,
        content: line,
        path: summary.path,
      })),
    ];
    return this.cached(cacheKey, {
      rows,
      contextRanges: [],
      message: truncated ? 'Large untracked file was truncated.' : null,
      binary: false,
      large: truncated,
      truncated,
    });
  }

  private async readUntrackedSummaries(
    worktreePath: string,
    notAddedPaths: readonly string[],
  ): Promise<ChangeReviewFileSummary[]> {
    const files = await mapWithConcurrency(
      notAddedPaths,
      UNTRACKED_SUMMARY_CONCURRENCY,
      async (filePath): Promise<ChangeReviewFileSummary | null> => {
        const absolutePath = path.join(worktreePath, filePath);
        const stat = await fs.stat(absolutePath).catch(() => null);
        if (!stat?.isFile()) {
          return null;
        }
        const stats = await this.readTextStats(absolutePath, stat.size);
        return {
          path: filePath,
          oldPath: null,
          status: 'added' as const,
          additions: stats.binary ? 0 : stats.lines,
          deletions: 0,
          binary: stats.binary,
          large: stat.size > LARGE_FILE_BYTES || stats.lines > LARGE_FILE_LINES,
          size: stat.size,
        };
      },
    );
    return files.filter(
      (file): file is ChangeReviewFileSummary => file !== null,
    );
  }

  private async readTextStats(
    absolutePath: string,
    size: number,
  ): Promise<{ lines: number; binary: boolean }> {
    if (size > LARGE_FILE_BYTES) {
      return { lines: LARGE_FILE_LINES + 1, binary: false };
    }
    const buffer = await fs.readFile(absolutePath);
    if (buffer.includes(0)) {
      return { lines: 0, binary: true };
    }
    if (size === 0) {
      return { lines: 0, binary: false };
    }
    const text = buffer.toString('utf8');
    return {
      lines: text.endsWith('\n')
        ? text.split('\n').length - 1
        : text.split('\n').length,
      binary: false,
    };
  }

  private async readCurrentFileSize(
    worktreePath: string,
    relativePath: string,
  ): Promise<number | null> {
    const stat = await fs
      .stat(path.join(worktreePath, relativePath))
      .catch(() => null);
    return stat?.isFile() ? stat.size : null;
  }

  private async detectBaseRef(
    git: SimpleGit,
    prBaseRef: string | null,
  ): Promise<string | null> {
    const candidates = [
      prBaseRef ? `origin/${prBaseRef}` : null,
      await git
        .raw(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
        .then((value) => value.trim())
        .catch(() => null),
      'origin/main',
      'origin/master',
    ].filter((value): value is string => Boolean(value));

    for (const candidate of candidates) {
      const exists = await git
        .raw(['rev-parse', '--verify', '--quiet', candidate])
        .then(() => true)
        .catch(() => false);
      if (exists) return candidate;
    }
    return null;
  }

  private async refreshLikelyBase(
    git: SimpleGit,
    repoRoot: string,
    prBaseRef: string | null,
  ): Promise<void> {
    const ref = prBaseRef ?? 'HEAD';
    const remote = await git
      .getRemotes(true)
      .then(
        (remotes) =>
          remotes.find((candidate) => candidate.name === 'origin') ??
          remotes[0],
      )
      .catch(() => null);
    if (!remote) return;
    await this.execGit(
      ['fetch', '--prune', remote.name, ref],
      repoRoot,
      8_000,
    ).catch(() => undefined);
  }

  private async readPullRequestInfo(
    repoRoot: string,
    branch: string,
  ): Promise<ChangeReviewPullRequestInfo | null> {
    const stdout = await this.execFileSafe(
      'gh',
      [
        'pr',
        'view',
        branch,
        '--json',
        'number,title,url,state,isDraft,baseRefName',
      ],
      repoRoot,
      3_000,
    );
    if (!stdout) return null;
    try {
      const parsed = JSON.parse(stdout);
      return {
        number: parsed.number,
        title: parsed.title,
        url: parsed.url,
        state: parsed.state,
        isDraft: Boolean(parsed.isDraft),
        baseRefName: parsed.baseRefName ?? null,
      };
    } catch {
      return null;
    }
  }

  private async readRefAgeSeconds(
    git: SimpleGit,
    ref: string,
  ): Promise<number | null> {
    const timestamp = await git
      .raw([
        'for-each-ref',
        '--format=%(committerdate:unix)',
        `refs/remotes/${ref}`,
      ])
      .then((value) => Number(value.trim()))
      .catch(() => 0);
    if (!timestamp) return null;
    return Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  }

  private execGit(
    args: string[],
    cwd: string,
    timeout: number,
  ): Promise<string> {
    return this.execFileSafe('git', args, cwd, timeout).then(
      (output) => output ?? '',
    );
  }

  private execFileSafe(
    command: string,
    args: string[],
    cwd: string,
    timeout: number,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(
        command,
        args,
        {
          cwd,
          timeout,
          maxBuffer: 2_000_000,
          env: {
            ...buildAugmentedEnv(process.env, cwd),
            GH_PROMPT_DISABLED: '1',
            GIT_TERMINAL_PROMPT: '0',
            NO_COLOR: '1',
          },
        },
        (error, stdout) => resolve(error ? null : stdout),
      );
    });
  }

  private toFileStatus(raw: string): ChangeReviewFileStatus {
    if (raw.startsWith('A')) return 'added';
    if (raw.startsWith('D')) return 'deleted';
    return 'modified';
  }

  private metaRow(filePath: string, content: string): ChangeReviewRow {
    return {
      id: `${filePath}:meta`,
      type: 'meta',
      oldLine: null,
      newLine: null,
      content,
      path: filePath,
    };
  }

  private getCachedRows(key: string): CachedRows | null {
    const cached = this.getFresh(this.rowCache, key);
    if (!cached) return null;
    return cached;
  }

  private cached(
    key: string,
    value: Omit<CachedRows, 'key' | 'createdAt' | 'changeHash'>,
  ): CachedRows {
    const cached = {
      key,
      createdAt: Date.now(),
      ...value,
      changeHash: this.hashRows(value.rows),
    };
    this.rowCache.set(key, cached);
    this.pruneCache(this.rowCache);
    return cached;
  }

  private hashRows(rows: ChangeReviewRow[]): string {
    const hash = createHash('sha256');
    for (const row of rows) {
      hash.update(row.type);
      hash.update('\0');
      hash.update(String(row.oldLine ?? ''));
      hash.update('\0');
      hash.update(String(row.newLine ?? ''));
      hash.update('\0');
      hash.update(row.content);
      hash.update('\0');
      hash.update(row.path);
      hash.update('\n');
    }
    return hash.digest('hex');
  }

  private getCachedBase(key: string): ReviewBase | null {
    return this.getFresh(this.baseCache, key)?.base ?? null;
  }

  private cachedBase(key: string, base: ReviewBase): ReviewBase {
    this.baseCache.set(key, { key, createdAt: Date.now(), base });
    this.pruneCache(this.baseCache);
    return base;
  }

  private getCachedFileSummaries(key: string): FileSummarySet | null {
    return this.getFresh(this.summaryCache, key)?.summaries ?? null;
  }

  private cachedFileSummaries(
    key: string,
    summaries: FileSummarySet,
  ): FileSummarySet {
    this.summaryCache.set(key, { key, createdAt: Date.now(), summaries });
    this.pruneCache(this.summaryCache);
    return summaries;
  }

  private getCachedFileLines(
    key: string,
  ): { oldLines: string[]; newLines: string[] } | null {
    return this.getFresh(this.fileLinesCache, key)?.lines ?? null;
  }

  private cachedFileLines(
    key: string,
    lines: { oldLines: string[]; newLines: string[] },
  ): { oldLines: string[]; newLines: string[] } {
    this.fileLinesCache.set(key, { key, createdAt: Date.now(), lines });
    this.pruneCache(this.fileLinesCache);
    return lines;
  }

  private getCachedContextWindow(
    key: string,
  ): ChangeReviewContextWindow | null {
    return this.getFresh(this.contextWindowCache, key)?.window ?? null;
  }

  private cachedContextWindow(
    key: string,
    window: ChangeReviewContextWindow,
  ): ChangeReviewContextWindow {
    this.contextWindowCache.set(key, { key, createdAt: Date.now(), window });
    this.pruneCache(this.contextWindowCache);
    return window;
  }

  private getFresh<T extends { createdAt: number }>(
    cache: Map<string, T>,
    key: string,
  ): T | null {
    const cached = cache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.createdAt > CACHE_TTL_MS) {
      cache.delete(key);
      return null;
    }
    return cached;
  }

  private pruneCache<T>(cache: Map<string, T>): void {
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (!oldestKey) return;
      cache.delete(oldestKey);
    }
  }

  private clearScopeCache(
    worktreePath: string,
    scope: ChangeReviewScope,
  ): void {
    const prefix = `${worktreePath}\0${scope}`;
    this.clearCacheMap(this.baseCache, prefix);
    this.clearCacheMap(this.summaryCache, prefix);
    this.clearCacheMap(this.rowCache, prefix);
    this.clearCacheMap(this.fileLinesCache, prefix);
    this.clearCacheMap(this.contextWindowCache, prefix);
    this.clearCacheMap(this.summaryBuilds, prefix);
    this.clearCacheMap(this.rowBuilds, prefix);
  }

  private clearCacheMap<T>(cache: Map<string, T>, prefix: string): void {
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) {
        cache.delete(key);
      }
    }
  }

  private assertScope(scope: ChangeReviewScope): void {
    if (!['uncommitted', 'last-commit', 'branch'].includes(scope)) {
      throw new BadRequestException(`Invalid change review scope: ${scope}`);
    }
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
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
