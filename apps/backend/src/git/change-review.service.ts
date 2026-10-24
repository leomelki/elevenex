import { BadRequestException, Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { createXXHash3, xxhash3 } from 'hash-wasm/dist/xxhash3.umd.min.js';
import { diffChars, diffWordsWithSpace, type Change } from 'diff';
import { SimpleGit, StatusResult } from 'simple-git';

import {
  buildAugmentedEnv,
  worktreeSimpleGit,
} from '../config/system-paths.js';
import {
  ChangeReviewContextWindow,
  ChangeReviewContextRange,
  ChangeReviewFileFingerprint,
  ChangeReviewFileFingerprintsResponse,
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
  WorktreeStatusFingerprintSnapshot,
  readWorktreeStatusSnapshot,
} from './git-worktree-fingerprint.js';

import {
  clearLocalRefState,
  readLocalRefSnapshot,
  readOriginHead,
  readPathVersion,
  type LocalRefSnapshot,
} from './git-local-state.js';
import {
  parseGitDiffRecords,
  renameDetectionMayBeLimited,
  type GitDiffRecord,
} from './git-diff-records.js';

import {
  restoredComparisonSources,
  withReviewIndex,
} from './git-review-index.js';
import { GitByteLru, GitCacheBudget, copyCacheString } from './git-cache.js';
import { readWorktreeTextStats } from './git-file-stats.js';
import { registerWorktreeCache } from './git-worktree-cache-lifecycle.js';

import {
  scheduledReadGit,
  gitReadScheduler,
  gitHashScheduler,
  gitRenderScheduler,
  gitFileScheduler,
  gitRepositoryKey,
  gitAbortError,
  consumeSharedGitWork,
} from './git-read-scheduler.js';

const DEFAULT_CHANGE_REVIEW_FILE_LIMIT = 2_000;
const MAX_FORCED_CHANGE_REVIEW_FILE_LIMIT = 20_000;
const LARGE_FILE_BYTES = 1_000_000;
const MAX_FORCED_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PATCH_ROWS = 50_000;
const LARGE_FILE_LINES = 25_000;
const DEFAULT_CONTEXT = 8;
/**
 * Context width that makes git emit an entire file as a single hunk. Anything
 * comfortably larger than the biggest file we are willing to render works.
 */
const FULL_FILE_CONTEXT = 1_000_000;
/**
 * Whole-file rendering is capped well below `LARGE_FILE_LINES`: the `large`
 * guard keys off *changed* lines, so a 20k-line file with three edits is not
 * "large" and would otherwise stream 20k rows on a full-file request.
 */
const FULL_FILE_MAX_LINES = 8_000;
/** Context width used when a full-file request exceeds `FULL_FILE_MAX_LINES`. */
const FULL_FILE_FALLBACK_CONTEXT = 200;
const DEFAULT_LIMIT = 400;
const DEFAULT_CONTEXT_RANGE_LIMIT = 120;
const MAX_LIMIT = 1_500;
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1_000;
const STALE_ORIGIN_SECONDS = 24 * 60 * 60;
const FILE_SUMMARY_CONCURRENCY = 32;
const UNTRACKED_SUMMARY_CONCURRENCY = 16;
const FILE_FINGERPRINT_CONCURRENCY = 16;
const FINGERPRINT_STREAM_THRESHOLD_BYTES = 1_000_000;
const LAST_COMMIT_WORKTREE_FINGERPRINT = '0'.repeat(64);
const VIEWED_FINGERPRINT_VERSION = 'cr-viewed-fp-v1';
const INLINE_CHANGE_SIMILARITY_THRESHOLD = 0.55;
const INLINE_CHANGE_MAX_LINE_LENGTH = 2_000;
const INLINE_CHANGE_MAX_EDIT_LENGTH = 512;

interface FileWindowOptions {
  offset?: number;
  limit?: number;
  context?: number;
  /** Render the whole file instead of hunks with limited context. */
  fullFile?: boolean;
  /** Allow opening a file that has no diff in this scope. */
  allowUnchanged?: boolean;
  forceLoad?: boolean;
  forceFileLoad?: boolean;
  signal?: AbortSignal;
}

interface ReviewBase {
  cacheGeneration: number;
  commonDir: string;
  indexVersion: string;
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

interface FileArtifactVersion {
  slot: string;
  identity: string;
  keys: Set<string>;
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
  backingTexts?: readonly string[];
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

interface CachedPullRequest {
  createdAt: number;
  pullRequest: ChangeReviewPullRequestInfo | null;
}

interface CachedFileCount {
  createdAt: number;
  count: number;
  renameDetectionLimited: boolean;
}

interface ReviewFileLines {
  oldLines: string[];
  newLines: string[];
  backingTexts?: readonly string[];
}

interface CachedFileLines {
  key: string;
  createdAt: number;
  lines: ReviewFileLines;
}

interface CachedContextWindow {
  key: string;
  createdAt: number;
  window: ChangeReviewContextWindow;
  backingTexts?: readonly string[];
}

interface WorktreeReviewState {
  snapshot?: WorktreeStatusFingerprintSnapshot;
  fingerprint: string;
  status: StatusResult | null;
}

interface ChangeReviewLoadCheck {
  guard: ChangeReviewLoadGuard | null;
  snapshot: WorktreeStatusFingerprintSnapshot | null;
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
  renameDetectionLimited?: boolean;
  restoredSources?: readonly GitDiffRecord[];
  originalOldPaths?: ReadonlyMap<string, string>;
}

interface FileSummaryLookup {
  summary: ChangeReviewFileSummary;
  untracked: boolean;
  restoredSources?: readonly GitDiffRecord[];
  graphFingerprint?: string;
}

@Injectable()
export class ChangeReviewService {
  private readonly unregisterCache = registerWorktreeCache(this);
  private readonly memoryBudget = new GitCacheBudget();
  // Keep selected-path metadata available when large row entries churn.
  private readonly lookupBudget = new GitCacheBudget(4 * 1024 * 1024);
  private readonly fileVersions = new WeakMap<
    ChangeReviewFileSummary,
    { record: GitDiffRecord }
  >();
  private readonly fileLookups = new GitByteLru<{
    createdAt: number;
    lookup: FileSummaryLookup;
    version: string;
  }>(this.lookupBudget);
  private readonly blobContent = new GitByteLru<string>(this.memoryBudget);
  private readonly blobBuilds = new Map<string, Promise<string>>();
  private readonly blobSizes = new GitByteLru<number>(this.memoryBudget);
  private readonly contentHashes = new GitByteLru<{
    version: string;
    identity: string;
  }>(this.memoryBudget);
  private readonly hashBuilds = new Map<string, Promise<string>>();
  private readonly fileArtifactVersions = new Map<
    string,
    FileArtifactVersion
  >();
  private readonly artifactOwners = new Map<string, FileArtifactVersion>();
  private nextCacheGeneration = 0;
  private readonly scopeGenerations = new Map<string, number>();
  private readonly worktreeRefs = new Map<string, string>();
  private readonly baseCache = new Map<string, CachedBase>();
  private readonly pullRequestCache = new Map<string, CachedPullRequest>();
  private readonly fileCountCache = new Map<string, CachedFileCount>();
  private readonly summaryCache = new GitByteLru<CachedFileSummaries>(
    this.memoryBudget,
  );
  private readonly rowCache = new GitByteLru<CachedRows>(this.memoryBudget);
  private readonly fileLinesCache = new GitByteLru<CachedFileLines>(
    this.memoryBudget,
  );
  private readonly contextWindowCache = new GitByteLru<CachedContextWindow>(
    this.memoryBudget,
  );
  private readonly summaryBuilds = new Map<string, Promise<FileSummarySet>>();
  private readonly fileLookupBuilds = new Map<
    string,
    Promise<FileSummaryLookup>
  >();
  private readonly rowBuilds = new Map<string, Promise<CachedRows>>();
  private readonly baseBuilds = new Map<string, Promise<ReviewBase>>();
  private readonly refreshBuilds = new Map<string, Promise<ReviewBase>>();
  private readonly fileCountBuilds = new Map<
    string,
    Promise<{ count: number; renameDetectionLimited: boolean }>
  >();
  private readonly fileLinesBuilds = new Map<
    string,
    Promise<ReviewFileLines>
  >();
  private readonly contextWindowBuilds = new Map<
    string,
    Promise<ChangeReviewContextWindow>
  >();

  async getSummary(
    worktreePath: string,
    scope: ChangeReviewScope,
    refreshBase = false,
    forceLoad = false,
  ): Promise<ChangeReviewSummary> {
    this.assertScope(scope);
    const git = scheduledReadGit(
      worktreeSimpleGit(worktreePath, { readOnly: true }),
      worktreePath,
    );
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
      loadCheck.snapshot,
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
      renameDetectionLimited: Boolean(summaries.renameDetectionLimited),
    };
  }

  getFileWindow(
    worktreePath: string,
    scope: ChangeReviewScope,
    filePath: string,
    options: FileWindowOptions = {},
  ): Promise<ChangeReviewFileWindow> {
    if (options.signal?.aborted)
      return Promise.reject(gitAbortError(options.signal));
    return consumeSharedGitWork(
      this.loadFileWindow(worktreePath, scope, filePath, options),
      options.signal,
    );
  }

  private async loadFileWindow(
    worktreePath: string,
    scope: ChangeReviewScope,
    filePath: string,
    options: FileWindowOptions = {},
  ): Promise<ChangeReviewFileWindow> {
    this.assertScope(scope);
    const offset = Math.max(0, Number(options.offset) || 0);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(options.limit) || DEFAULT_LIMIT),
    );
    const fullFile = Boolean(options.fullFile);
    const context = fullFile
      ? FULL_FILE_CONTEXT
      : Math.max(0, Math.min(200, Number(options.context) || DEFAULT_CONTEXT));

    const git = scheduledReadGit(
      worktreeSimpleGit(worktreePath, { readOnly: true }),
      worktreePath,
      10,
    );
    const base = await this.resolveBase(git, worktreePath, scope, false);
    options.signal?.throwIfAborted();
    const loadCheck = await this.readLoadCheck(
      git,
      worktreePath,
      scope,
      base,
      Boolean(options.forceLoad),
      false,
    );
    if (loadCheck.guard?.blocked) {
      throw new BadRequestException(this.loadGuardMessage(loadCheck.guard));
    }

    const worktreeState = await this.readWorktreeReviewState(
      git,
      worktreePath,
      scope,
      false,
      loadCheck.snapshot,
    );
    // An "open any file" request targets a path with no diff in this scope, so
    // the diff-driven summary lookup has nothing to return. Fall back to
    // synthesizing a window straight from the worktree contents.
    const lookup = await this.readFileSummary(
      git,
      worktreePath,
      scope,
      base,
      filePath,
      worktreeState,
    ).catch((error: unknown) => {
      if (!options.allowUnchanged) throw error;
      return null;
    });
    if (!lookup) {
      return gitRenderScheduler.run(
        gitRepositoryKey(worktreePath),
        () =>
          this.buildUnchangedFileWindow(worktreePath, scope, filePath, {
            offset,
            limit,
            forceFileLoad: Boolean(options.forceFileLoad),
          }),
        10,
        options.signal,
      );
    }
    options.signal?.throwIfAborted();
    const summary = lookup.summary;
    const cacheKey = await this.fileArtifactKey(
      'rows',
      git,
      worktreePath,
      scope,
      base,
      summary,
      [
        context,
        options.forceFileLoad ? 'force-file' : 'guarded-file',
        summary.additions,
        summary.deletions,
        summary.status,
      ],
    );
    const rowsPromise = this.getOrBuildRows(
      cacheKey,
      git,
      worktreePath,
      scope,
      base,
      lookup,
      context,
      Boolean(options.forceFileLoad),
      fullFile,
    );
    const fingerprintPromise =
      offset === 0
        ? this.buildFileFingerprint(git, worktreePath, scope, base, summary)
        : Promise.resolve(null);
    const [full, fingerprintResult] = await Promise.all([
      rowsPromise,
      fingerprintPromise,
    ]);
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
      fullFile,
      unchanged: false,
      changeHash: full.changeHash,
      fingerprint: fingerprintResult?.fingerprint ?? null,
      rows,
      contextRanges: full.contextRanges,
    };
  }

  async getFileFingerprints(
    worktreePath: string,
    scope: ChangeReviewScope,
    paths: readonly string[],
    forceLoad = false,
  ): Promise<ChangeReviewFileFingerprintsResponse> {
    this.assertScope(scope);
    const requestedPaths = [
      ...new Set(paths.map((value) => value.trim()).filter(Boolean)),
    ];
    if (requestedPaths.length === 0) {
      return {
        scope,
        worktreePath,
        fingerprints: [],
      };
    }

    const git = scheduledReadGit(
      worktreeSimpleGit(worktreePath, { readOnly: true }),
      worktreePath,
    );
    const base = await this.resolveBase(git, worktreePath, scope, false);
    const loadCheck = await this.readLoadCheck(
      git,
      worktreePath,
      scope,
      base,
      forceLoad,
    );
    if (loadCheck.guard?.blocked) {
      throw new BadRequestException(this.loadGuardMessage(loadCheck.guard));
    }

    const worktreeState = await this.readWorktreeReviewState(
      git,
      worktreePath,
      scope,
      false,
      loadCheck.snapshot,
    );
    const summaries = await this.readFileSummaries(
      git,
      worktreePath,
      scope,
      base,
      worktreeState,
    );
    const summariesByPath = this.indexSummariesByPath(summaries.files);
    const lookups = requestedPaths.map((filePath) => {
      const summary = summariesByPath.get(filePath);
      if (!summary) {
        throw new BadRequestException(
          `File is not changed in this scope: ${filePath}`,
        );
      }
      return summary;
    });
    const fingerprints = await mapWithConcurrency(
      lookups,
      FILE_FINGERPRINT_CONCURRENCY,
      async (summary) =>
        this.buildFileFingerprint(git, worktreePath, scope, base, summary),
    );

    return {
      scope,
      worktreePath,
      fingerprints,
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
    if (
      Math.max(oldStart, newStart) + Math.min(count, limit) >
      MAX_PATCH_ROWS
    ) {
      return {
        scope,
        path: filePath,
        oldStart,
        newStart,
        count,
        limit,
        rows: [
          this.metaRow(
            filePath,
            `Context reads are capped at ${MAX_PATCH_ROWS} lines.`,
          ),
        ],
      };
    }

    const git = scheduledReadGit(
      worktreeSimpleGit(worktreePath, { readOnly: true }),
      worktreePath,
      10,
    );
    const base = await this.resolveBase(git, worktreePath, scope, false);
    const loadCheck = await this.readLoadCheck(
      git,
      worktreePath,
      scope,
      base,
      Boolean(range.forceLoad),
      false,
    );
    if (loadCheck.guard?.blocked) {
      throw new BadRequestException(this.loadGuardMessage(loadCheck.guard));
    }

    const worktreeState = await this.readWorktreeReviewState(
      git,
      worktreePath,
      scope,
      false,
      loadCheck.snapshot,
    );
    const { summary } = await this.readFileSummary(
      git,
      worktreePath,
      scope,
      base,
      filePath,
      worktreeState,
    );
    const contextCacheKey = await this.fileArtifactKey(
      'context',
      git,
      worktreePath,
      scope,
      base,
      summary,
      [
        oldStart,
        newStart,
        count,
        limit,
        range.forceFileLoad ? 'force-file' : 'guarded-file',
        summary.additions,
        summary.deletions,
        summary.status,
      ],
    );
    const cached = this.getCachedContextWindow(contextCacheKey);
    if (cached) return cached;
    if (summary.binary)
      return {
        scope,
        path: summary.path,
        oldStart,
        newStart,
        count,
        limit,
        rows: [this.metaRow(summary.path, 'Binary file has no text context.')],
      };

    const byteGuard = await this.fileByteGuard(
      git,
      base,
      summary,
      Boolean(range.forceFileLoad),
    );
    if (byteGuard || (summary.large && !range.forceFileLoad)) {
      return {
        scope,
        path: summary.path,
        oldStart,
        newStart,
        count,
        limit,
        rows: [
          this.metaRow(
            summary.path,
            byteGuard ?? 'Large file context is hidden by default.',
          ),
        ],
      };
    }

    return this.getOrBuild(this.contextWindowBuilds, contextCacheKey, () =>
      gitRenderScheduler.run(
        gitRepositoryKey(worktreePath),
        async () => {
          const fileLines = await this.readReviewFileLines(
            git,
            worktreePath,
            scope,
            base,
            summary,
          );
          const rows = this.buildContextRows(
            summary.path,
            fileLines,
            oldStart,
            newStart,
            Math.min(count, limit),
          );

          return this.cachedContextWindow(
            contextCacheKey,
            {
              scope,
              path: summary.path,
              oldStart,
              newStart,
              count,
              limit,
              rows,
            },
            fileLines.backingTexts,
          );
        },
        10,
      ),
    );
  }

  private resolveBase(
    git: SimpleGit,
    worktreePath: string,
    scope: ChangeReviewScope,
    refreshBase: boolean,
  ): Promise<ReviewBase> {
    const scopeKey = [worktreePath, scope].join('\0');
    if (refreshBase) {
      // Simultaneous refreshes share the same invalidation and remote fetch.
      const refreshing = this.refreshBuilds.get(scopeKey);
      if (refreshing) return refreshing;
      this.clearScopeCache(worktreePath, scope);
      clearWorktreeFingerprintCache(worktreePath);
      clearLocalRefState(worktreePath);
      return this.getOrBuild(this.refreshBuilds, scopeKey, () =>
        this.resolveCurrentBase(git, worktreePath, scope, true),
      );
    }
    return this.resolveCurrentBase(git, worktreePath, scope, false);
  }

  private resolveCurrentBase(
    git: SimpleGit,
    worktreePath: string,
    scope: ChangeReviewScope,
    refreshBase: boolean,
  ): Promise<ReviewBase> {
    const generation = this.scopeGeneration(worktreePath, scope);
    const buildKey = [worktreePath, scope, generation, 'base'].join('\0');
    return this.getOrBuild(this.baseBuilds, buildKey, async () => {
      const localRefs = await readLocalRefSnapshot(git, worktreePath);
      const { repoRoot, branch, headSha } = localRefs;
      const refs = [branch, headSha ?? '', localRefs.indexVersion].join('\0');
      const previousRefs = this.worktreeRefs.get(worktreePath);
      if (previousRefs !== undefined && previousRefs !== refs) {
        // A commit/checkout can change status without changing file stats
        // (for example, an untracked file that has just been committed).
        clearWorktreeFingerprintCache(worktreePath);
      }
      this.worktreeRefs.delete(worktreePath);
      this.worktreeRefs.set(worktreePath, refs);
      this.pruneCache(this.worktreeRefs);
      let pullRequest: ChangeReviewPullRequestInfo | null = null;
      let baseRef: string | null = null;
      let baseSha: string | null = null;
      if (scope === 'branch') {
        const metadataKey = [
          worktreePath,
          scope,
          generation,
          branch,
          'pr',
        ].join('\0');
        const metadata = this.getFresh(this.pullRequestCache, metadataKey);
        if (metadata) {
          pullRequest = metadata.pullRequest;
        } else {
          pullRequest = await this.readPullRequestInfo(repoRoot, branch);
          this.cacheValue(this.pullRequestCache, metadataKey, {
            createdAt: Date.now(),
            pullRequest,
          });
        }
        if (refreshBase) {
          await this.refreshLikelyBase(
            git,
            repoRoot,
            pullRequest?.baseRefName ?? null,
          );
        }
        const detected = await this.detectBaseRef(
          git,
          pullRequest?.baseRefName ?? null,
          localRefs,
        );
        baseRef = detected?.ref ?? null;
        baseSha = detected?.sha ?? null;
      }
      const cacheKey = [
        buildKey,
        branch,
        headSha ?? '',
        localRefs.indexVersion,
        baseRef ?? '',
        baseSha ?? '',
        JSON.stringify(pullRequest),
      ].join('\0');
      const cached = this.getCachedBase(cacheKey);
      if (cached) return cached;

      let mergeBaseSha: string | null = null;
      let compareLabel: string;
      let originRefAgeSeconds: number | null = null;
      if (scope === 'last-commit') {
        baseSha = headSha
          ? await git
              .revparse([`${headSha}^`])
              .then((value) => value.trim())
              .catch(() => null)
          : null;
        compareLabel = 'Last commit';
      } else if (scope === 'uncommitted') {
        baseRef = 'HEAD';
        baseSha = headSha;
        mergeBaseSha = headSha;
        compareLabel = 'Uncommitted changes';
      } else {
        // Captured IDs keep a concurrent ref update from mixing an old headSha
        // with a merge base calculated from the new HEAD.
        mergeBaseSha =
          baseSha && headSha
            ? await git
                .raw(['merge-base', headSha, baseSha])
                .then((value) => value.trim())
                .catch(() => baseSha)
            : headSha;
        originRefAgeSeconds = baseRef
          ? await this.readRefAgeSeconds(git, baseRef)
          : null;
        compareLabel = baseRef
          ? `${branch} vs ${baseRef}`
          : `${branch} vs HEAD`;
      }
      return this.cachedBase(cacheKey, {
        cacheGeneration: generation,
        commonDir: localRefs.commonDir,
        indexVersion: localRefs.indexVersion,
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
      base.cacheGeneration,
      base.mergeBaseSha ?? base.baseSha ?? '',
      base.headSha ?? '',
      scope === 'last-commit' ? '' : worktreeState.fingerprint,
      'summary',
    ].join('\0');
    const cached = this.getCachedFileSummaries(cacheKey);
    if (cached) return cached;

    return this.getOrBuild(this.summaryBuilds, cacheKey, () =>
      this.buildFileSummaries(
        git,
        worktreePath,
        scope,
        base,
        worktreeState,
        cacheKey,
      ),
    );
  }

  private async buildFileSummaries(
    git: SimpleGit,
    worktreePath: string,
    scope: ChangeReviewScope,
    base: ReviewBase,
    worktreeState: WorktreeReviewState,
    cacheKey: string,
  ): Promise<FileSummarySet> {
    if (!base.headSha) {
      const paths = [
        ...new Set(worktreeState.status?.files.map((file) => file.path) ?? []),
      ];
      const files =
        scope === 'last-commit'
          ? []
          : await this.readUntrackedSummaries(worktreePath, paths);
      return this.cachedFileSummaries(cacheKey, {
        files,
        untrackedPaths: new Set(paths),
      });
    }
    const flags = [
      '--raw',
      '--numstat',
      '--no-abbrev',
      '-z',
      '--find-renames',
      '-l200',
    ];
    const readRecords = async (reader: SimpleGit) =>
      parseGitDiffRecords(
        await reader.raw(this.buildDiffArgs(scope, base, flags)),
      );
    let records = await readRecords(git);
    const originalOldPaths = new Map(
      records
        .filter((record) => record.oldPath)
        .map((record) => [record.path, record.oldPath!]),
    );
    const restoredSources =
      scope === 'last-commit'
        ? []
        : restoredComparisonSources(
            records,
            new Set(worktreeState.status?.not_added),
          );
    if (restoredSources.length)
      records = await withReviewIndex(
        git,
        worktreePath,
        restoredSources,
        readRecords,
      );
    const restoredPaths = new Set(restoredSources.map((source) => source.path));
    const untrackedPaths = new Set<string>();
    const renameDetectionLimited = renameDetectionMayBeLimited(records);
    const tracked = await mapWithConcurrency(
      records,
      FILE_SUMMARY_CONCURRENCY,
      (file) =>
        this.summarizeRecord(worktreePath, file, worktreeState.snapshot),
    );

    if (scope !== 'last-commit' && worktreeState.status) {
      const untracked = await this.readUntrackedSummaries(
        worktreePath,
        worktreeState.status.not_added.filter(
          (filePath) => !restoredPaths.has(filePath),
        ),
        worktreeState.snapshot,
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
      renameDetectionLimited,
      restoredSources,
      originalOldPaths,
    });
  }

  private async readLoadCheck(
    git: SimpleGit,
    worktreePath: string,
    scope: ChangeReviewScope,
    base: ReviewBase,
    forceLoad: boolean,
    validateCached = true,
  ): Promise<ChangeReviewLoadCheck> {
    const threshold = forceLoad
      ? MAX_FORCED_CHANGE_REVIEW_FILE_LIMIT
      : DEFAULT_CHANGE_REVIEW_FILE_LIMIT;

    const snapshot =
      scope === 'last-commit'
        ? null
        : await readWorktreeStatusSnapshot(worktreePath, git, {
            validateCached,
          });
    const status = snapshot?.status ?? null;
    const worktreeCounts = status
      ? this.countWorktreeChanges(status)
      : {
          totalFiles: 0,
          stagedFiles: 0,
          unstagedFiles: 0,
          conflictedFiles: 0,
        };

    if (worktreeCounts.totalFiles > threshold) {
      return {
        snapshot,
        guard: {
          blocked: true,
          threshold,
          totalFiles: worktreeCounts.totalFiles,
          stagedFiles: worktreeCounts.stagedFiles,
          unstagedFiles: worktreeCounts.unstagedFiles,
          conflictedFiles: worktreeCounts.conflictedFiles,
          reason: 'worktree',
        },
      };
    }

    const scopedCount =
      scope === 'uncommitted' || !base.headSha
        ? { count: worktreeCounts.totalFiles, renameDetectionLimited: false }
        : await this.countScopedFiles(
            git,
            worktreePath,
            scope,
            base,
            status,
            snapshot?.fingerprint ?? LAST_COMMIT_WORKTREE_FINGERPRINT,
          );
    const scopedFiles = scopedCount.count;
    if (scopedFiles > threshold) {
      return {
        snapshot,
        guard: {
          blocked: true,
          threshold,
          totalFiles: scopedFiles,
          stagedFiles: worktreeCounts.stagedFiles,
          unstagedFiles: worktreeCounts.unstagedFiles,
          conflictedFiles: worktreeCounts.conflictedFiles,
          reason: 'scope',
          renameDetectionLimited: scopedCount.renameDetectionLimited,
        },
      };
    }

    return { guard: null, snapshot };
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
    worktreePath: string,
    scope: ChangeReviewScope,
    base: ReviewBase,
    status: StatusResult | null,
    worktreeFingerprint: string,
  ): Promise<{ count: number; renameDetectionLimited: boolean }> {
    const cacheKey = [
      worktreePath,
      scope,
      base.cacheGeneration,
      base.mergeBaseSha ?? base.baseSha ?? '',
      base.headSha ?? '',
      worktreeFingerprint,
      'count',
    ].join('\0');
    const cached = this.getFresh(this.fileCountCache, cacheKey);
    if (cached) return cached;
    return this.getOrBuild(this.fileCountBuilds, cacheKey, async () => {
      const flags = ['--name-only', '-z', '--no-ext-diff', '--no-textconv'];
      const output = await git.raw(
        this.buildDiffArgs(scope, base, [...flags, '--no-renames']),
      );
      const untracked = new Set(
        scope === 'last-commit' ? [] : status?.not_added,
      );
      const names = output.split('\0').filter(Boolean);
      let count = names.length + untracked.size;
      let renameDetectionLimited = false;
      if (count > DEFAULT_CHANGE_REVIEW_FILE_LIMIT) {
        let restoredSources: GitDiffRecord[] = [];
        if (names.some((filePath) => untracked.has(filePath))) {
          const raw = await git.raw(
            this.buildDiffArgs(scope, base, [
              '--raw',
              '--no-abbrev',
              '-z',
              '--no-renames',
            ]),
          );
          restoredSources = restoredComparisonSources(
            parseGitDiffRecords(raw),
            untracked,
          );
        }
        await withReviewIndex(
          git,
          worktreePath,
          restoredSources,
          async (reader) => {
            const raw = await reader.raw(
              this.buildDiffArgs(scope, base, [
                '--raw',
                '--no-abbrev',
                '-z',
                '--find-renames',
                '-l200',
                '--no-ext-diff',
                '--no-textconv',
              ]),
            );
            const records = parseGitDiffRecords(raw);
            count = records.length + untracked.size - restoredSources.length;
            renameDetectionLimited = renameDetectionMayBeLimited(records);
          },
        );
      }
      this.cacheValue(this.fileCountCache, cacheKey, {
        createdAt: Date.now(),
        count,
        renameDetectionLimited,
      });
      return { count, renameDetectionLimited };
    });
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
    if (guard.threshold === MAX_FORCED_CHANGE_REVIEW_FILE_LIMIT)
      return `Diff loading is capped at ${guard.threshold} changed files. Narrow the change set to continue.`;
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
    const key = [
      worktreePath,
      scope,
      base.cacheGeneration,
      filePath,
      'lookup',
    ].join('\0');
    const cached = this.getFresh(this.fileLookups, key);
    const version = await this.fileLookupVersion(
      worktreePath,
      scope,
      base,
      filePath,
      worktreeState,
      cached?.lookup,
    );
    if (cached?.version === version) return cached.lookup;
    return this.getOrBuild(
      this.fileLookupBuilds,
      [key, version].join('\0'),
      async () => {
        let lookup: FileSummaryLookup;
        if (
          cached &&
          (!cached.lookup.graphFingerprint ||
            cached.lookup.graphFingerprint === worktreeState.fingerprint)
        ) {
          const paths = [
            ...new Set(
              [
                filePath,
                cached.lookup.summary.path,
                cached.lookup.summary.oldPath,
                ...(cached.lookup.restoredSources?.map(
                  (source) => source.path,
                ) ?? []),
              ].filter((value): value is string => value !== null),
            ),
          ];
          const flags = [
            '--raw',
            '--numstat',
            '--no-abbrev',
            '-z',
            '--find-renames',
            '-l200',
          ];
          const read = async (reader: SimpleGit) =>
            parseGitDiffRecords(
              await reader.raw([
                ...this.buildDiffArgs(scope, base, flags),
                '--',
                ...paths,
              ]),
            );
          const original = await read(git);
          const sources =
            scope === 'last-commit'
              ? []
              : restoredComparisonSources(
                  original,
                  new Set(worktreeState.status?.not_added),
                );
          const records = sources.length
            ? await withReviewIndex(git, worktreePath, sources, read, 10)
            : original;
          const record = records.find(
            (file) => file.path === filePath || file.oldPath === filePath,
          );
          if (record) {
            const summary = await this.summarizeRecord(worktreePath, record);
            lookup = this.makeFileLookup(
              summary,
              false,
              sources,
              original.find((file) => file.path === summary.path)?.oldPath,
              worktreeState.fingerprint,
            );
          } else {
            if (sources.length)
              throw new BadRequestException(
                `File is not changed in this scope: ${filePath}`,
              );
            const files = worktreeState.status?.not_added.includes(filePath)
              ? await this.readUntrackedSummaries(worktreePath, [filePath])
              : [];
            if (!files[0])
              throw new BadRequestException(
                `File is not changed in this scope: ${filePath}`,
              );
            lookup = { summary: files[0], untracked: true };
          }
        } else {
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
          if (!summary)
            throw new BadRequestException(
              `File is not changed in this scope: ${filePath}`,
            );
          lookup = this.makeFileLookup(
            summary,
            summaries.untrackedPaths.has(summary.path),
            summaries.restoredSources ?? [],
            summaries.originalOldPaths?.get(summary.path),
            worktreeState.fingerprint,
          );
        }
        const observedVersion = await this.fileLookupVersion(
          worktreePath,
          scope,
          base,
          filePath,
          worktreeState,
          cached?.lookup,
        );
        const storedVersion = await this.fileLookupVersion(
          worktreePath,
          scope,
          base,
          filePath,
          worktreeState,
          lookup,
        );
        if (observedVersion === version)
          this.cacheValue(this.fileLookups, key, {
            createdAt: Date.now(),
            lookup,
            version: storedVersion,
          });
        return lookup;
      },
    );
  }

  private makeFileLookup(
    summary: ChangeReviewFileSummary,
    untracked: boolean,
    sources: readonly GitDiffRecord[],
    originalOldPath: string | null | undefined,
    fingerprint: string,
  ): FileSummaryLookup {
    const related = new Set([summary.path, summary.oldPath, originalOldPath]);
    const restoredSources = sources.filter((source) =>
      related.has(source.path),
    );
    const lookup: FileSummaryLookup = {
      summary,
      untracked,
      ...(restoredSources.length ? { restoredSources } : {}),
    };
    if (
      summary.oldPath ||
      restoredSources.some((source) => source.path !== summary.path)
    )
      lookup.graphFingerprint = fingerprint;
    return lookup;
  }

  private async fileLookupVersion(
    worktreePath: string,
    scope: ChangeReviewScope,
    base: ReviewBase,
    filePath: string,
    state: WorktreeReviewState,
    lookup?: FileSummaryLookup,
  ): Promise<string> {
    if (scope === 'last-commit') return [base.baseSha, base.headSha].join('\0');
    const paths = [
      ...new Set(
        [
          filePath,
          lookup?.summary.path,
          lookup?.summary.oldPath,
          ...(lookup?.restoredSources?.map((source) => source.path) ?? []),
        ].filter((value): value is string => Boolean(value)),
      ),
    ];
    const versions = await Promise.all(
      paths
        .sort()
        .map((name) => readPathVersion(path.join(worktreePath, name))),
    );
    return [
      base.mergeBaseSha ?? base.baseSha,
      base.indexVersion,
      ...(lookup?.graphFingerprint ? [state.fingerprint] : []),
      ...versions,
    ].join('\0');
  }

  private async summarizeRecord(
    worktreePath: string,
    record: GitDiffRecord,
    snapshot?: WorktreeStatusFingerprintSnapshot,
  ): Promise<ChangeReviewFileSummary> {
    const size = snapshot?.pathSizes.has(record.path)
      ? snapshot.pathSizes.get(record.path)!
      : await this.readCurrentFileSize(worktreePath, record.path);
    const summary: ChangeReviewFileSummary = {
      path: record.path,
      oldPath: record.oldPath,
      status: record.status,
      additions: record.additions,
      deletions: record.deletions,
      binary: record.binary,
      large:
        record.additions + record.deletions > LARGE_FILE_LINES ||
        (size !== null && size > LARGE_FILE_BYTES),
      size,
    };
    this.fileVersions.set(summary, { record });
    return summary;
  }

  private async fileArtifactKey(
    kind: string,
    git: SimpleGit,
    worktreePath: string,
    scope: ChangeReviewScope,
    base: ReviewBase,
    summary: ChangeReviewFileSummary,
    options: unknown[],
  ): Promise<string> {
    const identity = await this.fileContentKey(
      git,
      worktreePath,
      scope,
      base,
      summary,
    );
    const prefix = [worktreePath, scope, base.cacheGeneration];
    const slot = [...prefix, summary.path].join('\0');
    let state = this.fileArtifactVersions.get(slot);
    if (!state || state.identity !== identity) {
      if (state) for (const key of state.keys) this.removeArtifact(key);
      state = { slot, identity, keys: new Set() };
      this.fileArtifactVersions.set(slot, state);
      this.pruneCache(this.fileArtifactVersions);
    }
    const key = [...prefix, kind, identity, ...options].join('\0');
    state.keys.add(key);
    this.artifactOwners.delete(key);
    this.artifactOwners.set(key, state);
    while (this.artifactOwners.size > MAX_CACHE_ENTRIES * 3) {
      for (const oldest of this.artifactOwners.keys()) {
        this.removeArtifact(oldest);
        break;
      }
    }
    return key;
  }

  private removeArtifact(key: string): void {
    this.rowCache.delete(key);
    this.fileLinesCache.delete(key);
    this.contextWindowCache.delete(key);
    this.artifactOwners.get(key)?.keys.delete(key);
    this.artifactOwners.delete(key);
  }

  private async fileContentKey(
    git: SimpleGit,
    worktreePath: string,
    scope: ChangeReviewScope,
    base: ReviewBase,
    summary: ChangeReviewFileSummary,
  ): Promise<string> {
    const record = this.fileVersions.get(summary)?.record;
    const oldIdentity = record?.oldOid ?? 'missing';
    const newIdentity =
      scope === 'last-commit'
        ? (record?.newOid ?? 'missing')
        : summary.status === 'deleted'
          ? 'missing'
          : await this.readWorktreeContentIdentity(worktreePath, summary.path);
    return [
      base.commonDir,
      oldIdentity,
      newIdentity,
      record?.oldMode,
      record?.newMode,
      summary.path,
      summary.oldPath,
      summary.status,
    ].join('\0');
  }

  private indexSummariesByPath(
    summaries: readonly ChangeReviewFileSummary[],
  ): Map<string, ChangeReviewFileSummary> {
    const byPath = new Map<string, ChangeReviewFileSummary>();
    for (const summary of summaries) {
      byPath.set(summary.path, summary);
      if (summary.oldPath) {
        byPath.set(summary.oldPath, summary);
      }
    }
    return byPath;
  }

  private async buildFileFingerprint(
    git: SimpleGit,
    worktreePath: string,
    scope: ChangeReviewScope,
    base: ReviewBase,
    summary: ChangeReviewFileSummary,
  ): Promise<ChangeReviewFileFingerprint> {
    const contentIdentity = await this.readViewedContentIdentity(
      git,
      worktreePath,
      scope,
      base,
      summary,
    );
    return {
      path: summary.path,
      oldPath: summary.oldPath,
      status: summary.status,
      fingerprint: [
        VIEWED_FINGERPRINT_VERSION,
        summary.status,
        encodeURIComponent(summary.oldPath ?? ''),
        contentIdentity,
      ].join(':'),
    };
  }

  private async readViewedContentIdentity(
    git: SimpleGit,
    worktreePath: string,
    scope: ChangeReviewScope,
    base: ReviewBase,
    summary: ChangeReviewFileSummary,
  ): Promise<string> {
    const record = this.fileVersions.get(summary)?.record;
    if (record && (scope === 'last-commit' || summary.status === 'deleted')) {
      const oid = summary.status === 'deleted' ? record.oldOid : record.newOid;
      return /^0+$/.test(oid) ? 'missing' : `git-blob:${oid}`;
    }
    if (scope === 'last-commit') {
      const ref =
        summary.status === 'deleted'
          ? (base.baseSha ?? 'HEAD^')
          : (base.headSha ?? 'HEAD');
      return this.readGitBlobIdentity(
        git,
        ref,
        summary.oldPath ?? summary.path,
      );
    }

    if (summary.status === 'deleted') {
      const oldRef =
        scope === 'branch'
          ? (base.mergeBaseSha ?? base.baseSha ?? 'HEAD')
          : (base.headSha ?? 'HEAD');
      return this.readGitBlobIdentity(
        git,
        oldRef,
        summary.oldPath ?? summary.path,
      );
    }

    return this.readWorktreeContentIdentity(worktreePath, summary.path);
  }

  private async readGitBlobIdentity(
    git: SimpleGit,
    ref: string,
    filePath: string,
  ): Promise<string> {
    const output = await git
      .raw(['ls-tree', '-z', ref, '--', filePath])
      .catch(() => '');
    const match = output.match(/^[0-7]{6} blob ([a-f0-9]{40,64})\t/);
    return match?.[1] ? `git-blob:${match[1]}` : 'missing';
  }

  private async readWorktreeContentIdentity(
    worktreePath: string,
    filePath: string,
  ): Promise<string> {
    const absolutePath = path.join(worktreePath, filePath);
    const version = await readPathVersion(absolutePath);
    if (version === 'missing') return 'missing';
    if (version.startsWith('gitlink:')) return version;
    const cached = this.contentHashes.get(absolutePath);
    if (cached?.version === version) return cached.identity;
    return this.getOrBuild(
      this.hashBuilds,
      [absolutePath, version].join('\0'),
      async () => {
        const info = await fs.lstat(absolutePath);
        if (!info.isFile() && !info.isSymbolicLink()) return 'missing';
        if (info.size > MAX_FORCED_FILE_BYTES) {
          const identity = `oversized:${version}`;
          this.contentHashes.set(absolutePath, { version, identity });
          return identity;
        }
        const digest = await gitHashScheduler.run(
          gitRepositoryKey(worktreePath),
          () =>
            info.isSymbolicLink()
              ? fs
                  .readlink(absolutePath)
                  .then((link) => xxhash3(Buffer.from(link)))
              : this.hashWorktreeFile(absolutePath, info.size),
          10,
        );
        const identity = `xxh3-64:${digest}`;
        if ((await readPathVersion(absolutePath)) !== version)
          throw new BadRequestException(
            'File changed while reading; retry the request.',
          );
        this.contentHashes.set(absolutePath, { version, identity });
        return identity;
      },
    );
  }

  private async hashWorktreeFile(
    absolutePath: string,
    size: number,
  ): Promise<string> {
    if (size <= FINGERPRINT_STREAM_THRESHOLD_BYTES) {
      return xxhash3(await this.readBoundedFileContents(absolutePath));
    }

    const hasher = await createXXHash3();
    hasher.init();
    let bytes = 0;
    for await (const chunk of createReadStream(absolutePath, {
      end: MAX_FORCED_FILE_BYTES,
    })) {
      bytes += (chunk as Buffer).length;
      if (bytes > MAX_FORCED_FILE_BYTES)
        throw new BadRequestException(
          'File grew beyond the byte limit; retry the request.',
        );
      hasher.update(chunk as Buffer);
    }
    return hasher.digest('hex');
  }

  private async getOrBuildRows(
    cacheKey: string,
    git: SimpleGit,
    worktreePath: string,
    scope: ChangeReviewScope,
    base: ReviewBase,
    lookup: FileSummaryLookup,
    context: number,
    forceFileLoad: boolean,
    fullFile: boolean,
  ): Promise<CachedRows> {
    const cached = this.getCachedRows(cacheKey);
    if (cached) return cached;

    return this.getOrBuild(this.rowBuilds, cacheKey, () =>
      gitRenderScheduler.run(
        gitRepositoryKey(worktreePath),
        () =>
          this.buildRows(
            git,
            worktreePath,
            scope,
            base,
            lookup,
            context,
            cacheKey,
            forceFileLoad,
            fullFile,
          ),
        10,
      ),
    );
  }

  private async buildRows(
    git: SimpleGit,
    worktreePath: string,
    scope: ChangeReviewScope,
    base: ReviewBase,
    lookup: FileSummaryLookup,
    context: number,
    cacheKey: string,
    forceFileLoad: boolean,
    fullFile = false,
  ): Promise<CachedRows> {
    let result: CachedRows;
    const summary = lookup.summary;

    if (summary.binary) {
      result = await this.cached(cacheKey, {
        rows: [this.metaRow(summary.path, 'Binary file changed')],
        contextRanges: [],
        message: 'Binary file changed.',
        binary: true,
        large: false,
        truncated: false,
      });
      return result;
    }

    const byteGuard =
      summary.large && !forceFileLoad
        ? null
        : await this.fileByteGuard(git, base, summary, forceFileLoad);
    if ((summary.large && !forceFileLoad) || byteGuard) {
      result = await this.cached(cacheKey, {
        rows: [
          this.metaRow(summary.path, 'Large file diff is hidden by default.'),
        ],
        contextRanges: [],
        message:
          byteGuard ?? 'Large file diff omitted from automatic rendering.',
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

    // Read the file contents first: a full-file request needs the line count to
    // decide how wide a context it can afford before asking git for the patch.
    const fileLines = await this.readReviewFileLines(
      git,
      worktreePath,
      scope,
      base,
      summary,
    );

    const fileLineCount = Math.max(
      fileLines.newLines.length,
      fileLines.oldLines.length,
    );
    const cappedFullFile =
      fullFile && !forceFileLoad && fileLineCount > FULL_FILE_MAX_LINES;
    const effectiveContext = cappedFullFile
      ? FULL_FILE_FALLBACK_CONTEXT
      : context;

    const readPatch = (reader: SimpleGit) =>
      reader.raw([
        ...this.buildDiffArgs(scope, base, [
          '--diff-algorithm=histogram',
          `--unified=${effectiveContext}`,
          '--find-renames',
        ]),
        '--',
        ...new Set(
          [summary.oldPath, summary.path].filter(
            (value): value is string => value !== null,
          ),
        ),
      ]);
    const patch = await withReviewIndex(
      git,
      worktreePath,
      lookup.restoredSources ?? [],
      readPatch,
      10,
    );
    if (scope !== 'last-commit') {
      const expected = this.contentHashes.get(
        path.join(worktreePath, summary.path),
      )?.version;
      if (
        expected &&
        (await readPathVersion(path.join(worktreePath, summary.path))) !==
          expected
      )
        throw new BadRequestException(
          'File changed while reading; retry the request.',
        );
    }
    const parsed = await this.parsePatchRows(summary.path, patch, fileLines);

    // Patches that carry no hunks — pure renames, mode changes — still emit
    // preamble lines, so "no rows" is the wrong test. What full-file mode
    // promises is *coverage*: every line of the file is shown. When the patch
    // doesn't deliver that, synthesize the file from its contents instead.
    const rows = this.ensureFullFileCoverage(
      parsed.rows,
      summary,
      fileLines,
      fullFile && !cappedFullFile,
    );

    result = await this.cached(cacheKey, {
      backingTexts: rows === parsed.rows ? [patch] : fileLines.backingTexts,
      rows: rows.length
        ? rows
        : [this.metaRow(summary.path, 'No textual diff for this file.')],
      contextRanges: parsed.contextRanges,
      message:
        rows.length >= MAX_PATCH_ROWS || fileLineCount > MAX_PATCH_ROWS
          ? `Diff output is capped at ${MAX_PATCH_ROWS} rows.`
          : cappedFullFile
            ? `Whole-file view is capped at ${FULL_FILE_MAX_LINES.toLocaleString()} lines; showing wide context instead.`
            : null,
      binary: false,
      large: false,
      truncated:
        cappedFullFile ||
        rows.length >= MAX_PATCH_ROWS ||
        fileLineCount > MAX_PATCH_ROWS,
    });
    return result;
  }

  /**
   * In full-file mode, guarantee the returned rows cover every line of the new
   * file. Falls back to rendering the file as plain context when the patch does
   * not (a rename or mode change carries preamble but no hunks).
   */
  private ensureFullFileCoverage(
    rows: ChangeReviewRow[],
    summary: ChangeReviewFileSummary,
    fileLines: { oldLines: string[]; newLines: string[] },
    fullFile: boolean,
  ): ChangeReviewRow[] {
    if (!fullFile || summary.status === 'deleted') return rows;

    const lineCount = fileLines.newLines.length;
    if (lineCount === 0) return rows;

    const covered = new Set<number>();
    for (const row of rows) {
      if (row.newLine !== null) covered.add(row.newLine);
    }
    if (covered.size >= lineCount) return rows;

    return this.buildContextRows(
      summary.path,
      fileLines,
      1,
      1,
      Math.min(lineCount, MAX_PATCH_ROWS),
    );
  }

  /**
   * Window for a file with no diff in the current scope — the "open any file"
   * path. Every row is plain context, so the same renderer handles it without
   * knowing the difference.
   */
  private async buildUnchangedFileWindow(
    worktreePath: string,
    scope: ChangeReviewScope,
    filePath: string,
    options: { offset: number; limit: number; forceFileLoad: boolean },
  ): Promise<ChangeReviewFileWindow> {
    const absolutePath = path.join(worktreePath, filePath);
    const stat = await fs.stat(absolutePath).catch(() => null);
    if (!stat?.isFile()) {
      throw new BadRequestException(`File not found in worktree: ${filePath}`);
    }

    const base = this.unchangedWindowBase(scope, filePath, options);
    if (
      stat.size > MAX_FORCED_FILE_BYTES ||
      (stat.size > LARGE_FILE_BYTES && !options.forceFileLoad)
    ) {
      return {
        ...base,
        message: 'Large file omitted from automatic rendering.',
        large: true,
        truncated: true,
        totalRows: 1,
        rows: [this.metaRow(filePath, 'Large file is hidden by default.')],
      };
    }

    const buffer = await this.readBoundedWorktreeFile(absolutePath);
    if (buffer.includes(0)) {
      return {
        ...base,
        message: 'Binary file.',
        binary: true,
        totalRows: 1,
        rows: [this.metaRow(filePath, 'Binary file')],
      };
    }

    const lines = this.splitFileLines(buffer.toString('utf8'));
    const truncated = lines.length > FULL_FILE_MAX_LINES;
    const visible = truncated ? lines.slice(0, FULL_FILE_MAX_LINES) : lines;
    const allRows = visible.map((content, index) => ({
      id: `${filePath}:context:${index + 1}:${index + 1}`,
      type: 'context' as const,
      oldLine: index + 1,
      newLine: index + 1,
      content,
      path: filePath,
    }));
    const rows = allRows.slice(options.offset, options.offset + options.limit);

    return {
      ...base,
      message: truncated
        ? `File view is capped at ${FULL_FILE_MAX_LINES.toLocaleString()} lines.`
        : null,
      truncated,
      totalRows: allRows.length,
      hasMore: options.offset + rows.length < allRows.length,
      changeHash: await this.hashRows(allRows),
      fingerprint:
        options.offset === 0
          ? await this.readWorktreeContentIdentity(worktreePath, filePath)
          : null,
      rows,
    };
  }

  private unchangedWindowBase(
    scope: ChangeReviewScope,
    filePath: string,
    options: { offset: number; limit: number },
  ): ChangeReviewFileWindow {
    return {
      scope,
      path: filePath,
      oldPath: null,
      status: 'modified',
      binary: false,
      large: false,
      truncated: false,
      message: null,
      offset: options.offset,
      limit: options.limit,
      totalRows: 0,
      hasMore: false,
      context: FULL_FILE_CONTEXT,
      fullFile: true,
      unchanged: true,
      changeHash: '',
      fingerprint: null,
      rows: [],
      contextRanges: [],
    };
  }

  private buildDiffArgs(
    scope: ChangeReviewScope,
    base: ReviewBase,
    flags: string[],
  ): string[] {
    if (scope === 'last-commit') {
      if (base.baseSha && base.headSha)
        return ['diff', ...flags, base.baseSha, base.headSha];
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
        : (base.headSha ?? 'HEAD');
    return ['diff', ...flags, ref];
  }

  private async readWorktreeReviewState(
    git: SimpleGit,
    worktreePath: string,
    scope: ChangeReviewScope,
    validateCached = false,
    knownSnapshot: WorktreeStatusFingerprintSnapshot | null = null,
  ): Promise<WorktreeReviewState> {
    if (scope === 'last-commit') {
      return {
        fingerprint: LAST_COMMIT_WORKTREE_FINGERPRINT,
        status: null,
      };
    }

    const snapshot =
      knownSnapshot ??
      (await readWorktreeStatusSnapshot(worktreePath, git, {
        validateCached,
      }));
    return {
      fingerprint: snapshot.fingerprint,
      status: snapshot.status,
      snapshot,
    };
  }

  private async parsePatchRows(
    filePath: string,
    patch: string,
    fileLines: { oldLines: string[]; newLines: string[] },
  ): Promise<{
    rows: ChangeReviewRow[];
    contextRanges: ChangeReviewContextRange[];
  }> {
    const rows: ChangeReviewRow[] = [];
    const contextRanges: ChangeReviewContextRange[] = [];
    let oldLine: number | null = null;
    let newLine: number | null = null;
    let previousOldEnd = 0;
    let previousNewEnd = 0;
    let rowIndex = 0;

    for (const line of this.textLines(patch)) {
      if (rows.length >= MAX_PATCH_ROWS) break;
      if (rowIndex > 0 && rowIndex % 512 === 0) await yieldToEventLoop();
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
    if (rows.length < MAX_PATCH_ROWS && previousOldEnd > 0 && trailingGap > 0) {
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

    return { rows: await this.collapseModifiedRows(rows), contextRanges };
  }

  private async collapseModifiedRows(
    rows: ChangeReviewRow[],
  ): Promise<ChangeReviewRow[]> {
    const collapsed: ChangeReviewRow[] = [];
    let index = 0;
    let remainingComparisons = 256;

    while (index < rows.length) {
      if (index % 512 === 0) await yieldToEventLoop();
      if (rows[index]?.type !== 'delete') {
        collapsed.push(rows[index]);
        index += 1;
        continue;
      }

      const deleteStart = index;
      while (rows[index]?.type === 'delete') index += 1;
      const addStart = index;
      while (rows[index]?.type === 'add') index += 1;

      const deletedRows = rows.slice(deleteStart, addStart);
      const addedRows = rows.slice(addStart, index);
      let canCollapse =
        deletedRows.length > 0 &&
        deletedRows.length === addedRows.length &&
        deletedRows.length <= remainingComparisons;
      if (canCollapse)
        for (let rowIndex = 0; rowIndex < deletedRows.length; rowIndex++) {
          if (rowIndex % 8 === 0) await yieldToEventLoop();
          remainingComparisons--;
          if (
            !this.shouldCollapseModifiedLine(
              deletedRows[rowIndex].content,
              addedRows[rowIndex].content,
            )
          ) {
            canCollapse = false;
            break;
          }
        }

      if (!canCollapse) {
        for (const row of deletedRows) collapsed.push(row);
        for (const row of addedRows) collapsed.push(row);
        continue;
      }

      for (let rowIndex = 0; rowIndex < deletedRows.length; rowIndex += 1) {
        const deleted = deletedRows[rowIndex];
        const added = addedRows[rowIndex];
        collapsed.push({
          ...added,
          id: `${deleted.id}:change:${added.id}`,
          type: 'change',
          oldLine: deleted.oldLine,
          newLine: added.newLine,
          oldContent: deleted.content,
          content: added.content,
        });
      }
    }

    return collapsed;
  }

  private shouldCollapseModifiedLine(
    oldContent: string,
    newContent: string,
  ): boolean {
    if (!oldContent || !newContent || oldContent === newContent) return false;
    if (!oldContent.trim() || !newContent.trim()) return false;
    if (
      oldContent.length > INLINE_CHANGE_MAX_LINE_LENGTH ||
      newContent.length > INLINE_CHANGE_MAX_LINE_LENGTH
    ) {
      return false;
    }

    const wordSimilarity = this.diffSimilarity(
      diffWordsWithSpace(oldContent, newContent, {
        maxEditLength: INLINE_CHANGE_MAX_EDIT_LENGTH,
        timeout: 5,
      }),
    );
    if (wordSimilarity >= INLINE_CHANGE_SIMILARITY_THRESHOLD) return true;

    return (
      this.diffSimilarity(
        diffChars(oldContent, newContent, {
          maxEditLength: INLINE_CHANGE_MAX_EDIT_LENGTH,
          timeout: 5,
        }),
      ) >= INLINE_CHANGE_SIMILARITY_THRESHOLD
    );
  }

  private diffSimilarity(changes: Change[] | undefined): number {
    if (!changes?.length) return 0;
    const equal = changes.reduce(
      (sum, change) =>
        change.added || change.removed ? sum : sum + change.value.length,
      0,
    );
    const removed = changes.reduce(
      (sum, change) => (change.added ? sum : sum + change.value.length),
      0,
    );
    const added = changes.reduce(
      (sum, change) => (change.removed ? sum : sum + change.value.length),
      0,
    );
    return equal / Math.max(removed, added, 1);
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
  ): Promise<ReviewFileLines> {
    // Capture before choosing the content key: a queued build must not publish
    // newer file contents under an identity calculated before the queue wait.
    const currentVersion =
      scope === 'last-commit'
        ? null
        : await readPathVersion(path.join(worktreePath, summary.path));
    const cacheKey = await this.fileArtifactKey(
      'lines',
      git,
      worktreePath,
      scope,
      base,
      summary,
      [
        summary.oldPath ?? '',
        summary.path,
        summary.status,
        summary.additions,
        summary.deletions,
        'lines',
      ],
    );
    const cached = this.getCachedFileLines(cacheKey);
    if (cached) return cached;

    return this.getOrBuild(this.fileLinesBuilds, cacheKey, async () => {
      const oldRef =
        scope === 'last-commit'
          ? (base.baseSha ?? 'HEAD^')
          : scope === 'branch'
            ? (base.mergeBaseSha ?? base.baseSha ?? 'HEAD')
            : (base.headSha ?? 'HEAD');
      const newRef = scope === 'last-commit' ? (base.headSha ?? 'HEAD') : null;
      const oldPath = summary.oldPath ?? summary.path;

      const record = this.fileVersions.get(summary)?.record;
      const readBlob = (
        oid: string | undefined,
        mode: string | undefined,
        ref: string,
        filePath: string,
      ) => {
        // Gitlinks reference commits in the nested repository. The parent
        // object store need not contain those objects.
        if (mode === '160000')
          return Promise.resolve(`Subproject commit ${oid}\n`);
        if (!oid || /^0+$/.test(oid))
          return this.readGitFile(git, ref, filePath);
        const key = [base.commonDir, oid].join('\0');
        const cached = this.blobContent.get(key);
        if (cached !== undefined) return Promise.resolve(cached);
        return this.getOrBuild(this.blobBuilds, key, async () => {
          const text = await this.readGitFile(git, oid, '');
          this.blobContent.set(key, text);
          return text;
        });
      };
      const [oldText, newText] = await Promise.all([
        summary.status === 'added'
          ? Promise.resolve('')
          : readBlob(record?.oldOid, record?.oldMode, oldRef, oldPath),
        summary.status === 'deleted'
          ? Promise.resolve('')
          : newRef
            ? readBlob(record?.newOid, record?.newMode, newRef, summary.path)
            : record?.newMode === '160000'
              ? Promise.resolve(
                  `Subproject commit ${
                    currentVersion?.startsWith('gitlink:')
                      ? currentVersion.slice('gitlink:'.length)
                      : record.newOid
                  }\n`,
                )
              : this.readWorktreeFile(worktreePath, summary.path),
      ]);
      if (
        currentVersion !== null &&
        (await readPathVersion(path.join(worktreePath, summary.path))) !==
          currentVersion
      )
        throw new BadRequestException(
          'File changed while reading; retry the request.',
        );

      return this.cachedFileLines(cacheKey, {
        oldLines: this.splitFileLines(oldText),
        newLines: this.splitFileLines(newText),
        backingTexts: [oldText, newText],
      });
    });
  }

  private async readGitFile(
    git: SimpleGit,
    ref: string,
    filePath: string,
  ): Promise<string> {
    return git.raw(['show', filePath ? `${ref}:${filePath}` : ref]);
  }

  private async readWorktreeFile(
    worktreePath: string,
    filePath: string,
  ): Promise<string> {
    return this.readBoundedWorktreeFile(path.join(worktreePath, filePath)).then(
      (buffer) => buffer.toString('utf8'),
    );
  }

  private async readBoundedWorktreeFile(absolutePath: string): Promise<Buffer> {
    return gitHashScheduler.run(
      gitRepositoryKey(absolutePath),
      () => this.readBoundedFileContents(absolutePath),
      10,
    );
  }

  private async readBoundedFileContents(
    absolutePath: string,
    maxBytes = MAX_FORCED_FILE_BYTES,
  ): Promise<Buffer> {
    const info = await fs.lstat(absolutePath);
    if (info.isSymbolicLink())
      return Buffer.from(await fs.readlink(absolutePath));
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of createReadStream(absolutePath, {
      end: maxBytes,
    })) {
      const buffer = chunk as Buffer;
      bytes += buffer.length;
      if (bytes > maxBytes)
        throw new BadRequestException(
          'File exceeds the forced-load byte limit.',
        );
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, bytes);
  }

  private async fileByteGuard(
    git: SimpleGit,
    base: ReviewBase,
    summary: ChangeReviewFileSummary,
    force: boolean,
  ): Promise<string | null> {
    const record = this.fileVersions.get(summary)?.record;
    const sizes = [summary.size ?? 0];
    const blobs = [
      record?.oldMode === '160000' ? null : record?.oldOid,
      record?.newMode === '160000' ? null : record?.newOid,
    ];
    for (const oid of new Set(blobs)) {
      if (!oid || /^0+$/.test(oid)) continue;
      const key = [base.commonDir, oid, 'size'].join('\0');
      let size = this.blobSizes.get(key);
      if (size === undefined) {
        size = Number((await git.raw(['cat-file', '-s', oid])).trim());
        this.blobSizes.set(key, size);
      }
      sizes.push(size);
    }
    const max = Math.max(...sizes);
    if (max > MAX_FORCED_FILE_BYTES)
      return `File exceeds the ${MAX_FORCED_FILE_BYTES} byte forced-load limit.`;
    return !force && max > LARGE_FILE_BYTES
      ? 'Large historical or current file omitted from automatic rendering.'
      : null;
  }

  private splitFileLines(text: string): string[] {
    if (!text) return [];
    const lines: string[] = [];
    for (const line of this.textLines(text)) {
      lines.push(line.endsWith('\r') ? line.slice(0, -1) : line);
      if (lines.length > MAX_PATCH_ROWS) break;
    }
    return lines;
  }

  private *textLines(text: string): Generator<string> {
    let start = 0;
    while (start < text.length) {
      const end = text.indexOf('\n', start);
      if (end < 0) {
        yield text.slice(start);
        return;
      }
      yield text.slice(start, end);
      start = end + 1;
    }
  }

  private async buildUntrackedRows(
    worktreePath: string,
    summary: ChangeReviewFileSummary,
    cacheKey: string,
    forceFileLoad: boolean,
  ): Promise<CachedRows> {
    const absolutePath = path.join(worktreePath, summary.path);
    const stat = await fs.lstat(absolutePath);
    if (
      stat.size > MAX_FORCED_FILE_BYTES ||
      (stat.size > LARGE_FILE_BYTES && !forceFileLoad)
    ) {
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
    const buffer = await this.readBoundedWorktreeFile(absolutePath);
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
    const lines = this.splitFileLines(text);
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
      backingTexts: [text],
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
    snapshot?: WorktreeStatusFingerprintSnapshot,
  ): Promise<ChangeReviewFileSummary[]> {
    const files = await mapWithConcurrency(
      notAddedPaths,
      UNTRACKED_SUMMARY_CONCURRENCY,
      async (filePath): Promise<ChangeReviewFileSummary | null> => {
        const size = snapshot?.pathSizes.has(filePath)
          ? snapshot.pathSizes.get(filePath)!
          : await this.readCurrentFileSize(worktreePath, filePath);
        if (size === null) return null;
        const shared = await readWorktreeTextStats(
          worktreePath,
          filePath,
          snapshot?.pathVersions.get(filePath),
          size,
        );
        const stats = {
          lines: shared.lines ?? LARGE_FILE_LINES + 1,
          binary: shared.binary,
        };
        return {
          path: copyCacheString(filePath),
          oldPath: null,
          status: 'added' as const,
          additions: stats.binary ? 0 : stats.lines,
          deletions: 0,
          binary: stats.binary,
          large: size > LARGE_FILE_BYTES || stats.lines > LARGE_FILE_LINES,
          size,
        };
      },
    );
    return files.filter(
      (file): file is ChangeReviewFileSummary => file !== null,
    );
  }

  private async readCurrentFileSize(
    worktreePath: string,
    relativePath: string,
  ): Promise<number | null> {
    const stat = await gitFileScheduler
      .run(gitRepositoryKey(worktreePath), () =>
        fs.lstat(path.join(worktreePath, relativePath)),
      )
      .catch(() => null);
    return stat && (stat.isFile() || stat.isSymbolicLink()) ? stat.size : null;
  }

  private async detectBaseRef(
    git: SimpleGit,
    prBaseRef: string | null,
    refs: LocalRefSnapshot,
  ): Promise<{ ref: string; sha: string } | null> {
    const candidates = [
      prBaseRef ? `origin/${prBaseRef}` : null,
      await readOriginHead(refs),
      'origin/main',
      'origin/master',
    ];
    for (const ref of new Set(candidates)) {
      if (!ref) continue;
      const sha = await refs.resolveRef(ref);
      if (sha) return { ref, sha };
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

  private async cached(
    key: string,
    value: Omit<CachedRows, 'key' | 'createdAt' | 'changeHash'>,
  ): Promise<CachedRows> {
    const cached = {
      key,
      createdAt: Date.now(),
      ...value,
      changeHash: await this.hashRows(value.rows),
    };
    this.cacheValue(this.rowCache, key, cached);
    return cached;
  }

  private async hashRows(rows: ChangeReviewRow[]): Promise<string> {
    const hash = createHash('sha256');
    // Preserve the serialized bytes while avoiding twelve native crypto calls
    // per row. Bound temporary input and yield between visible-row batches.
    for (let offset = 0; offset < rows.length; offset += 256) {
      const input = rows
        .slice(offset, offset + 256)
        .map(
          (row) =>
            [
              row.type,
              String(row.oldLine ?? ''),
              String(row.newLine ?? ''),
              row.content,
              row.oldContent ?? '',
              row.path,
            ].join('\0') + '\n',
        )
        .join('');
      hash.update(input);
      if (offset + 256 < rows.length) await yieldToEventLoop();
    }
    return hash.digest('hex');
  }

  private getCachedBase(key: string): ReviewBase | null {
    return this.getFresh(this.baseCache, key)?.base ?? null;
  }

  private cachedBase(key: string, base: ReviewBase): ReviewBase {
    this.cacheValue(this.baseCache, key, { key, createdAt: Date.now(), base });
    return base;
  }

  private getCachedFileSummaries(key: string): FileSummarySet | null {
    return this.getFresh(this.summaryCache, key)?.summaries ?? null;
  }

  private cachedFileSummaries(
    key: string,
    summaries: FileSummarySet,
  ): FileSummarySet {
    this.cacheValue(this.summaryCache, key, {
      key,
      createdAt: Date.now(),
      summaries,
    });
    return summaries;
  }

  private getCachedFileLines(key: string): ReviewFileLines | null {
    return this.getFresh(this.fileLinesCache, key)?.lines ?? null;
  }

  private cachedFileLines(
    key: string,
    lines: ReviewFileLines,
  ): ReviewFileLines {
    this.cacheValue(this.fileLinesCache, key, {
      key,
      createdAt: Date.now(),
      lines,
    });
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
    backingTexts: readonly string[] = [],
  ): ChangeReviewContextWindow {
    this.cacheValue(this.contextWindowCache, key, {
      key,
      createdAt: Date.now(),
      window,
      backingTexts,
    });
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
    if (!(cache instanceof GitByteLru)) {
      cache.delete(key);
      cache.set(key, cached);
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

  private getOrBuild<T>(
    builds: Map<string, Promise<T>>,
    key: string,
    build: () => Promise<T>,
  ): Promise<T> {
    const inFlight = builds.get(key);
    if (inFlight) return inFlight;
    const promise = build().finally(() => {
      // A cleared build may finish after its replacement has started.
      if (builds.get(key) === promise) builds.delete(key);
    });
    builds.set(key, promise);
    return promise;
  }

  private scopeGeneration(
    worktreePath: string,
    scope: ChangeReviewScope,
  ): number {
    const key = [worktreePath, scope].join('\0');
    let generation = this.scopeGenerations.get(key);
    if (generation === undefined) {
      generation = ++this.nextCacheGeneration;
      this.scopeGenerations.set(key, generation);
      this.pruneCache(this.scopeGenerations);
    }
    return generation;
  }

  private cacheValue<T>(cache: Map<string, T>, key: string, value: T): void {
    const [worktreePath, scope, generation] = key.split('\0', 3);
    if (
      this.scopeGenerations.get([worktreePath, scope].join('\0')) !==
      Number(generation)
    ) {
      return;
    }
    if (
      (cache as object) === this.rowCache ||
      (cache as object) === this.fileLinesCache ||
      (cache as object) === this.contextWindowCache
    ) {
      const owner = this.artifactOwners.get(key);
      if (!owner || this.fileArtifactVersions.get(owner.slot) !== owner) return;
    }
    cache.set(key, value);
    this.pruneCache(cache);
  }

  private clearScopeCache(
    worktreePath: string,
    scope: ChangeReviewScope,
  ): void {
    this.scopeGenerations.delete([worktreePath, scope].join('\0'));
    const prefix = `${worktreePath}\0${scope}\0`;
    this.clearCacheMap(this.baseCache, prefix);
    this.clearCacheMap(this.pullRequestCache, prefix);
    this.clearCacheMap(this.fileCountCache, prefix);
    this.clearCacheMap(this.baseBuilds, prefix);
    this.clearCacheMap(this.fileCountBuilds, prefix);
    this.clearCacheMap(this.fileLinesBuilds, prefix);
    this.clearCacheMap(this.contextWindowBuilds, prefix);
    this.clearCacheMap(this.summaryCache, prefix);
    this.clearCacheMap(this.rowCache, prefix);
    this.clearCacheMap(this.fileLookups, prefix);
    this.clearCacheMap(this.fileLinesCache, prefix);
    this.clearCacheMap(this.contextWindowCache, prefix);
    this.clearCacheMap(this.summaryBuilds, prefix);
    this.clearCacheMap(this.rowBuilds, prefix);
    this.clearCacheMap(this.fileLookupBuilds, prefix);
    for (const key of this.artifactOwners.keys())
      if (key.startsWith(prefix)) this.removeArtifact(key);
    this.clearCacheMap(this.fileArtifactVersions, prefix);
  }

  private clearCacheMap<T>(cache: Map<string, T>, prefix: string): void {
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) {
        cache.delete(key);
      }
    }
  }

  cacheDiagnostics() {
    return {
      bytes: this.memoryBudget.bytes + this.lookupBudget.bytes,
      maxBytes: this.memoryBudget.maxBytes + this.lookupBudget.maxBytes,
      hits: this.memoryBudget.hits,
      queue: gitReadScheduler.diagnostics(),
    };
  }

  releaseWorktree(worktreePath: string): void {
    for (const scope of ['branch', 'uncommitted', 'last-commit'] as const) {
      this.clearScopeCache(worktreePath, scope);
      this.refreshBuilds.delete([worktreePath, scope].join('\0'));
    }
    this.worktreeRefs.delete(worktreePath);
    clearWorktreeFingerprintCache(worktreePath);
    clearLocalRefState(worktreePath);
    const prefix = path.resolve(worktreePath) + path.sep;
    for (const key of this.contentHashes.keys())
      if (key.startsWith(prefix)) this.contentHashes.delete(key);
  }

  onModuleDestroy(): void {
    this.unregisterCache();
    for (const worktreePath of this.worktreeRefs.keys())
      this.releaseWorktree(worktreePath);
    this.blobContent.clear();
    this.blobSizes.clear();
    this.contentHashes.clear();
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
