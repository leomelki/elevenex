import { Injectable } from '@nestjs/common';
import * as path from 'node:path';
import { GitService, PushResult } from '../git/git.service.js';
import {
  GhCommandError,
  GhCommandRunnerService,
} from './gh-command-runner.service.js';
import {
  RepoContextResolverService,
  type RepoContext,
} from './repo-context-resolver.service.js';
import type {
  GitHubBranchContext,
  GitHubCapabilities,
  LinkedPullRequestSummary,
  PullRequestCheckRollup,
  PullRequestConversation,
  PullRequestDetail,
  PullRequestFileDiff,
  PullRequestReviewThread,
} from './github.types.js';

interface CacheEntry<T> {
  data: T;
  createdAt: number;
  worktreePath: string;
  estimatedBytes: number;
}

@Injectable()
export class GithubService {
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly cacheTtlMs = 10_000;
  private readonly maxCacheEntries = 64;
  private readonly maxCacheBytes = 32 * 1024 * 1024;
  private readonly maxEntryBytes = 8 * 1024 * 1024;
  private cacheBytes = 0;
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly runner: GhCommandRunnerService,
    private readonly repoContextResolver: RepoContextResolverService,
    private readonly gitService: GitService,
  ) {}

  async getCapabilities(
    worktreePath: string,
    refresh = false,
  ): Promise<GitHubCapabilities> {
    const context = await this.repoContextResolver.resolve(worktreePath);
    return this.readCached('capabilities', context, refresh, async () => {
      const ghInstalled = await this.runner.isInstalled(context.repoRoot);

      if (!ghInstalled) {
        return {
          ghInstalled: false,
          authenticated: false,
          hasGitHubRemote: Boolean(
            context.host && context.owner && context.repo,
          ),
          hasUpstream: Boolean(context.upstream),
          linkedPullRequest: false,
          defaultRemote: context.remoteName,
          host: context.host,
          repoOwner: context.owner,
          repoName: context.repo,
          message: 'GitHub CLI is not installed on the backend host.',
        };
      }

      const authenticated = await this.isAuthenticated(context.repoRoot);
      const linkedPullRequest = authenticated
        ? Boolean(
            await this.findLinkedPullRequest(
              context.worktreePath,
              refresh,
              context,
            ),
          )
        : false;

      return {
        ghInstalled: true,
        authenticated,
        hasGitHubRemote: Boolean(
          context.host === 'github.com' && context.owner && context.repo,
        ),
        hasUpstream: Boolean(context.upstream),
        linkedPullRequest,
        defaultRemote: context.remoteName,
        host: context.host,
        repoOwner: context.owner,
        repoName: context.repo,
        message: this.buildCapabilityMessage(context, authenticated),
      };
    });
  }

  async getBranchContext(
    worktreePath: string,
    refresh = false,
    resolvedContext?: RepoContext,
  ): Promise<GitHubBranchContext> {
    const context =
      resolvedContext ?? (await this.repoContextResolver.resolve(worktreePath));
    return this.readCached('context', context, refresh, async () => {
      const linkedPullRequest = await this.findLinkedPullRequest(
        worktreePath,
        refresh,
        context,
      );
      const response: GitHubBranchContext = {
        repoRoot: context.repoRoot,
        worktreePath: context.worktreePath,
        branch: context.branch,
        upstream: context.upstream,
        ahead: context.ahead,
        behind: context.behind,
        remoteName: context.remoteName,
        host: context.host,
        owner: context.owner,
        name: context.repo,
        linkedPullRequest,
      };
      return response;
    });
  }

  async getPullRequest(
    worktreePath: string,
    refresh = false,
    resolvedContext?: RepoContext,
  ): Promise<PullRequestDetail | null> {
    const context =
      resolvedContext ?? (await this.repoContextResolver.resolve(worktreePath));
    return this.readCached('pr', context, refresh, async () => {
      if (!this.supportsGitHub(context)) {
        return null;
      }

      const raw = await this.runPrViewJson(context, [
        'number',
        'title',
        'url',
        'state',
        'isDraft',
        'body',
        'author',
        'baseRefName',
        'headRefName',
        'createdAt',
        'updatedAt',
        'mergeable',
        'mergeStateStatus',
        'comments',
        'reviews',
        'reviewDecision',
      ]);

      if (!raw) {
        return null;
      }

      const checks = await this.getPullRequestChecks(
        worktreePath,
        refresh,
        context,
      );
      const reviewersMap = new Map<
        string,
        {
          login: string;
          name: string | null;
          avatarUrl: string | null;
          state: string | null;
        }
      >();

      for (const review of raw.reviews ?? []) {
        if (!review?.author?.login) continue;
        reviewersMap.set(review.author.login, {
          login: review.author.login,
          name: review.author.name ?? null,
          avatarUrl: review.author.avatarUrl ?? null,
          state: review.state ?? null,
        });
      }

      const detail: PullRequestDetail = {
        number: raw.number,
        title: raw.title,
        url: raw.url,
        state: raw.state,
        isDraft: Boolean(raw.isDraft),
        body: raw.body ?? '',
        author: raw.author
          ? {
              login: raw.author.login,
              name: raw.author.name ?? null,
              avatarUrl: raw.author.avatarUrl ?? null,
            }
          : null,
        baseRefName: raw.baseRefName,
        headRefName: raw.headRefName,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        mergeable: raw.mergeable ?? 'UNKNOWN',
        mergeStateStatus: raw.mergeStateStatus ?? 'UNKNOWN',
        commentsCount: Array.isArray(raw.comments) ? raw.comments.length : 0,
        reviewDecision: raw.reviewDecision ?? null,
        checksSummary: checks.summary,
        reviewers: Array.from(reviewersMap.values()),
      };

      return detail;
    });
  }

  async getPullRequestDiff(
    worktreePath: string,
    refresh = false,
    resolvedContext?: RepoContext,
  ): Promise<PullRequestFileDiff[]> {
    const context =
      resolvedContext ?? (await this.repoContextResolver.resolve(worktreePath));
    return this.readCached('diff', context, refresh, async () => {
      const summary = await this.findLinkedPullRequest(
        worktreePath,
        refresh,
        context,
      );
      if (!summary) {
        return [];
      }

      const diffRaw = await this.runner.run(
        [
          'pr',
          'diff',
          String(summary.number),
          '--repo',
          `${context.owner}/${context.repo}`,
        ],
        context.repoRoot,
      );
      const conversation = await this.getPullRequestConversation(
        worktreePath,
        refresh,
        context,
      );
      const threadsByPath = conversation.threads.reduce<
        Map<string, PullRequestReviewThread[]>
      >((map, thread) => {
        const existing = map.get(thread.path) || [];
        existing.push(thread);
        map.set(thread.path, existing);
        return map;
      }, new Map());

      const diff = this.parseUnifiedDiff(diffRaw).map((file) => ({
        ...file,
        threads: threadsByPath.get(file.path) || [],
      }));
      return diff;
    });
  }

  async getPullRequestConversation(
    worktreePath: string,
    refresh = false,
    resolvedContext?: RepoContext,
  ): Promise<PullRequestConversation> {
    const context =
      resolvedContext ?? (await this.repoContextResolver.resolve(worktreePath));
    return this.readCached('conversation', context, refresh, async () => {
      const pr = await this.runPrViewJson(context, [
        'number',
        'comments',
        'reviews',
      ]);
      if (!pr) {
        const empty = { reviews: [], comments: [], threads: [] };
        return empty;
      }

      const threads = await this.getReviewThreads(
        context.repoRoot,
        context.owner!,
        context.repo!,
        pr.number,
      );
      const conversation: PullRequestConversation = {
        reviews: (pr.reviews ?? []).map((review: any) => ({
          id: String(review.id),
          authorLogin: review.author?.login ?? 'unknown',
          authorAvatarUrl: review.author?.avatarUrl ?? null,
          state: review.state ?? 'COMMENTED',
          body: review.body ?? '',
          submittedAt: review.submittedAt ?? null,
        })),
        comments: (pr.comments ?? []).map((comment: any) => ({
          id: String(comment.id),
          authorLogin: comment.author?.login ?? 'unknown',
          authorAvatarUrl: comment.author?.avatarUrl ?? null,
          body: comment.body ?? '',
          createdAt: comment.createdAt,
          url: comment.url ?? null,
        })),
        threads,
      };

      return conversation;
    });
  }

  async getPullRequestChecks(
    worktreePath: string,
    refresh = false,
    resolvedContext?: RepoContext,
  ): Promise<PullRequestCheckRollup> {
    const context =
      resolvedContext ?? (await this.repoContextResolver.resolve(worktreePath));
    return this.readCached('checks', context, refresh, async () => {
      const summary = await this.findLinkedPullRequest(
        worktreePath,
        refresh,
        context,
      );
      if (!summary) {
        const empty = {
          summary: { total: 0, passing: 0, failing: 0, pending: 0 },
          checks: [],
        };
        return empty;
      }

      let stdout = '';
      try {
        stdout = await this.runner.run(
          [
            'pr',
            'checks',
            String(summary.number),
            '--repo',
            `${context.owner}/${context.repo}`,
            '--json',
            'bucket,name,workflow,state,description,link,startedAt,completedAt',
          ],
          context.repoRoot,
        );
      } catch (error) {
        if (error instanceof GhCommandError && error.stdout) {
          stdout = error.stdout;
        } else {
          throw error;
        }
      }

      const checks = JSON.parse(stdout || '[]').map((check: any) => ({
        name: check.name,
        workflow: check.workflow ?? null,
        state: check.state,
        bucket: check.bucket,
        description: check.description ?? null,
        link: check.link ?? null,
        startedAt: check.startedAt ?? null,
        completedAt: check.completedAt ?? null,
      }));

      const rollup: PullRequestCheckRollup = {
        summary: {
          total: checks.length,
          passing: checks.filter((check: any) => check.bucket === 'pass')
            .length,
          failing: checks.filter(
            (check: any) =>
              check.bucket === 'fail' || check.bucket === 'cancel',
          ).length,
          pending: checks.filter((check: any) => check.bucket === 'pending')
            .length,
        },
        checks,
      };

      return rollup;
    });
  }

  async addComment(
    worktreePath: string,
    body: string,
  ): Promise<{ success: boolean }> {
    const context = await this.repoContextResolver.resolve(worktreePath);
    const pr = await this.findLinkedPullRequest(worktreePath, true, context);
    if (!pr) {
      throw new Error('No pull request is linked to this branch.');
    }

    await this.runner.run(
      [
        'pr',
        'comment',
        String(pr.number),
        '--repo',
        `${context.owner}/${context.repo}`,
        '--body',
        body,
      ],
      context.repoRoot,
    );
    this.invalidate(worktreePath);
    return { success: true };
  }

  async submitReview(
    worktreePath: string,
    event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES',
    body: string,
  ): Promise<{ success: boolean }> {
    const context = await this.repoContextResolver.resolve(worktreePath);
    const pr = await this.findLinkedPullRequest(worktreePath, true, context);
    if (!pr) {
      throw new Error('No pull request is linked to this branch.');
    }

    const flags =
      event === 'APPROVE'
        ? ['--approve']
        : event === 'REQUEST_CHANGES'
          ? ['--request-changes']
          : ['--comment'];

    await this.runner.run(
      [
        'pr',
        'review',
        String(pr.number),
        '--repo',
        `${context.owner}/${context.repo}`,
        ...flags,
        '--body',
        body,
      ],
      context.repoRoot,
    );
    this.invalidate(worktreePath);
    return { success: true };
  }

  async push(worktreePath: string): Promise<PushResult> {
    const result = await this.gitService.push(worktreePath);
    if (result.pushed) this.invalidate(worktreePath);
    return result;
  }

  invalidate(worktreePath: string): void {
    worktreePath = path.resolve(worktreePath);
    // Invalidated reads may finish for their original caller, but cannot
    // repopulate the cache or remove a replacement in-flight read.
    for (const [key, entry] of this.cache) {
      if (entry.worktreePath === worktreePath) this.deleteCached(key);
    }
    for (const key of this.inFlight.keys()) {
      if (JSON.parse(key)[1] === worktreePath) this.inFlight.delete(key);
    }
  }

  private async findLinkedPullRequest(
    worktreePath: string,
    refresh = false,
    resolvedContext?: RepoContext,
  ): Promise<LinkedPullRequestSummary | null> {
    const context =
      resolvedContext ?? (await this.repoContextResolver.resolve(worktreePath));
    return this.readCached('pr-summary', context, refresh, async () => {
      const raw = await this.runPrViewJson(context, [
        'number',
        'title',
        'url',
        'state',
        'isDraft',
      ]);
      const summary = raw
        ? {
            number: raw.number,
            title: raw.title,
            url: raw.url,
            state: raw.state,
            isDraft: Boolean(raw.isDraft),
          }
        : null;
      return summary;
    });
  }

  private async runPrViewJson(
    context: RepoContext,
    fields: string[],
  ): Promise<any | null> {
    if (!this.supportsGitHub(context)) {
      return null;
    }

    try {
      const stdout = await this.runner.run(
        [
          'pr',
          'view',
          context.branch,
          '--repo',
          `${context.owner}/${context.repo}`,
          '--json',
          fields.join(','),
        ],
        context.repoRoot,
      );
      return JSON.parse(stdout);
    } catch (error) {
      if (
        error instanceof GhCommandError &&
        /no pull requests found/i.test(error.stderr || error.message)
      ) {
        return null;
      }
      if (
        error instanceof GhCommandError &&
        /authentication required|not logged into/i.test(
          `${error.stderr} ${error.stdout} ${error.message}`,
        )
      ) {
        return null;
      }
      throw error;
    }
  }

  private async getReviewThreads(
    repoRoot: string,
    owner: string,
    repo: string,
    number: number,
  ): Promise<PullRequestReviewThread[]> {
    const query = `
      query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 100) {
              nodes {
                id
                isResolved
                path
                line
                originalLine
                comments(first: 20) {
                  nodes {
                    id
                    body
                    createdAt
                    url
                    author {
                      login
                      avatarUrl
                    }
                  }
                }
              }
            }
          }
        }
      }
    `.trim();

    try {
      const stdout = await this.runner.run(
        [
          'api',
          'graphql',
          '-f',
          `query=${query}`,
          '-F',
          `owner=${owner}`,
          '-F',
          `repo=${repo}`,
          '-F',
          `number=${number}`,
        ],
        repoRoot,
      );

      const nodes =
        JSON.parse(stdout)?.data?.repository?.pullRequest?.reviewThreads
          ?.nodes ?? [];
      return nodes.map((thread: any) => ({
        id: thread.id,
        path: thread.path,
        line: typeof thread.line === 'number' ? thread.line : null,
        originalLine:
          typeof thread.originalLine === 'number' ? thread.originalLine : null,
        isResolved: Boolean(thread.isResolved),
        comments: (thread.comments?.nodes ?? []).map((comment: any) => ({
          id: comment.id,
          authorLogin: comment.author?.login ?? 'unknown',
          authorAvatarUrl: comment.author?.avatarUrl ?? null,
          body: comment.body ?? '',
          createdAt: comment.createdAt,
          url: comment.url ?? null,
        })),
      }));
    } catch {
      return [];
    }
  }

  private parseUnifiedDiff(diff: string): PullRequestFileDiff[] {
    const chunks = diff
      .split(/^diff --git /m)
      .map((chunk) => chunk.trim())
      .filter(Boolean);

    return chunks.map((chunk) => {
      const normalizedChunk = chunk.startsWith('a/')
        ? `diff --git ${chunk}`
        : `diff --git ${chunk}`;
      const lines = normalizedChunk.split('\n');
      const header = lines[0] ?? '';
      const match = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const oldPath = match?.[1] ?? null;
      const path = match?.[2] ?? oldPath ?? 'unknown';

      let status: PullRequestFileDiff['status'] = 'modified';
      if (lines.some((line) => line.startsWith('new file mode'))) {
        status = 'added';
      } else if (lines.some((line) => line.startsWith('deleted file mode'))) {
        status = 'removed';
      } else if (lines.some((line) => line.startsWith('rename from '))) {
        status = 'renamed';
      }

      const additions = lines.filter(
        (line) => line.startsWith('+') && !line.startsWith('+++'),
      ).length;
      const deletions = lines.filter(
        (line) => line.startsWith('-') && !line.startsWith('---'),
      ).length;

      return {
        path,
        oldPath: status === 'renamed' ? oldPath : null,
        status,
        additions,
        deletions,
        patch: normalizedChunk,
        threads: [],
      };
    });
  }

  private supportsGitHub(
    context: Awaited<ReturnType<RepoContextResolverService['resolve']>>,
  ): boolean {
    return (
      context.host === 'github.com' && Boolean(context.owner && context.repo)
    );
  }

  private buildCapabilityMessage(
    context: Awaited<ReturnType<RepoContextResolverService['resolve']>>,
    authenticated: boolean,
  ): string | null {
    if (!this.supportsGitHub(context)) {
      return 'This repository does not have a github.com remote.';
    }
    if (!authenticated) {
      return 'Run `gh auth login` on the backend host to enable GitHub features.';
    }
    if (!context.upstream) {
      return 'This branch has no upstream yet. Push once to enable linked PR resolution.';
    }
    return null;
  }

  private async isAuthenticated(repoRoot: string): Promise<boolean> {
    try {
      await this.runner.run(
        ['auth', 'status', '--hostname', 'github.com'],
        repoRoot,
      );
      return true;
    } catch (error) {
      if (error instanceof GhCommandError) {
        return false;
      }
      throw error;
    }
  }

  private readCached<T>(
    kind: string,
    context: RepoContext,
    refresh: boolean,
    read: () => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([
      kind,
      context.worktreePath,
      context.branch,
      context.headSha,
      context.upstream,
      context.ahead,
      context.behind,
      context.remoteName,
      context.host,
      context.owner,
      context.repo,
    ]);
    const cached = this.cache.get(key);
    // A cached null is a successful negative lookup, not a cache miss.
    if (!refresh && cached && Date.now() - cached.createdAt < this.cacheTtlMs) {
      return Promise.resolve(cached.data as T);
    }
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const pending = Promise.resolve()
      .then(read)
      .then((data) => {
        if (this.inFlight.get(key) === pending) {
          const now = Date.now();
          for (const [oldKey, entry] of this.cache) {
            if (now - entry.createdAt >= this.cacheTtlMs)
              this.deleteCached(oldKey);
          }
          this.deleteCached(key);
          const estimatedBytes = this.estimateCacheBytes(
            data,
            this.maxEntryBytes,
          );
          if (estimatedBytes <= this.maxEntryBytes) {
            this.cache.set(key, {
              data,
              createdAt: now,
              worktreePath: context.worktreePath,
              estimatedBytes,
            });
            this.cacheBytes += estimatedBytes;
          }
          while (
            this.cache.size > this.maxCacheEntries ||
            this.cacheBytes > this.maxCacheBytes
          ) {
            this.deleteCached(this.cache.keys().next().value!);
          }
        }
        return data;
      })
      .finally(() => {
        if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
      });
    this.inFlight.set(key, pending);
    return pending;
  }

  private deleteCached(key: string): void {
    const entry = this.cache.get(key);
    if (entry) this.cacheBytes -= entry.estimatedBytes;
    this.cache.delete(key);
  }

  /** Estimate retained JSON data without serializing/copying large patches. */
  private estimateCacheBytes(value: unknown, budget: number): number {
    if (typeof value === 'string') return value.length * 2;
    if (!value || typeof value !== 'object') return 8;
    let size = 64;
    for (const [key, child] of Object.entries(value)) {
      size += key.length * 2 + this.estimateCacheBytes(child, budget - size);
      if (size > budget) break;
    }
    return size;
  }
}
