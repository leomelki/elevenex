import { Injectable } from '@nestjs/common';
import { GitService, PushResult } from '../git/git.service.js';
import { GhCommandError, GhCommandRunnerService } from './gh-command-runner.service.js';
import { RepoContextResolverService } from './repo-context-resolver.service.js';
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
}

@Injectable()
export class GithubService {
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly cacheTtlMs = 10_000;

  constructor(
    private readonly runner: GhCommandRunnerService,
    private readonly repoContextResolver: RepoContextResolverService,
    private readonly gitService: GitService,
  ) {}

  async getCapabilities(worktreePath: string, refresh = false): Promise<GitHubCapabilities> {
    const context = await this.repoContextResolver.resolve(worktreePath);
    const ghInstalled = await this.runner.isInstalled(context.repoRoot);

    if (!ghInstalled) {
      return {
        ghInstalled: false,
        authenticated: false,
        hasGitHubRemote: Boolean(context.host && context.owner && context.repo),
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
      ? Boolean(await this.findLinkedPullRequest(context.worktreePath, refresh))
      : false;

    return {
      ghInstalled: true,
      authenticated,
      hasGitHubRemote: Boolean(context.host === 'github.com' && context.owner && context.repo),
      hasUpstream: Boolean(context.upstream),
      linkedPullRequest,
      defaultRemote: context.remoteName,
      host: context.host,
      repoOwner: context.owner,
      repoName: context.repo,
      message: this.buildCapabilityMessage(context, authenticated),
    };
  }

  async getBranchContext(worktreePath: string, refresh = false): Promise<GitHubBranchContext> {
    const cacheKey = `context:${worktreePath}`;
    if (!refresh) {
      const cached = this.getCache<GitHubBranchContext>(cacheKey);
      if (cached) return cached;
    }

    const context = await this.repoContextResolver.resolve(worktreePath);
    const linkedPullRequest = await this.findLinkedPullRequest(worktreePath, refresh);
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
    this.setCache(cacheKey, response);
    return response;
  }

  async getPullRequest(worktreePath: string, refresh = false): Promise<PullRequestDetail | null> {
    const cacheKey = `pr:${worktreePath}`;
    if (!refresh) {
      const cached = this.getCache<PullRequestDetail | null>(cacheKey);
      if (cached !== null) return cached;
    }

    const context = await this.repoContextResolver.resolve(worktreePath);
    if (!this.supportsGitHub(context)) {
      this.setCache(cacheKey, null);
      return null;
    }

    const raw = await this.runPrViewJson(worktreePath, [
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
      this.setCache(cacheKey, null);
      return null;
    }

    const checks = await this.getPullRequestChecks(worktreePath, refresh);
    const reviewersMap = new Map<string, { login: string; name: string | null; avatarUrl: string | null; state: string | null }>();

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
      author: raw.author ? {
        login: raw.author.login,
        name: raw.author.name ?? null,
        avatarUrl: raw.author.avatarUrl ?? null,
      } : null,
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

    this.setCache(cacheKey, detail);
    return detail;
  }

  async getPullRequestDiff(worktreePath: string, refresh = false): Promise<PullRequestFileDiff[]> {
    const cacheKey = `diff:${worktreePath}`;
    if (!refresh) {
      const cached = this.getCache<PullRequestFileDiff[]>(cacheKey);
      if (cached) return cached;
    }

    const summary = await this.findLinkedPullRequest(worktreePath, refresh);
    if (!summary) {
      this.setCache(cacheKey, []);
      return [];
    }

    const context = await this.repoContextResolver.resolve(worktreePath);
    const diffRaw = await this.runner.run(['pr', 'diff', String(summary.number), '--repo', `${context.owner}/${context.repo}`], context.repoRoot);
    const conversation = await this.getPullRequestConversation(worktreePath, refresh);
    const threadsByPath = conversation.threads.reduce<Map<string, PullRequestReviewThread[]>>((map, thread) => {
      const existing = map.get(thread.path) || [];
      existing.push(thread);
      map.set(thread.path, existing);
      return map;
    }, new Map());

    const diff = this.parseUnifiedDiff(diffRaw).map(file => ({
      ...file,
      threads: threadsByPath.get(file.path) || [],
    }));
    this.setCache(cacheKey, diff);
    return diff;
  }

  async getPullRequestConversation(worktreePath: string, refresh = false): Promise<PullRequestConversation> {
    const cacheKey = `conversation:${worktreePath}`;
    if (!refresh) {
      const cached = this.getCache<PullRequestConversation>(cacheKey);
      if (cached) return cached;
    }

    const context = await this.repoContextResolver.resolve(worktreePath);
    const pr = await this.runPrViewJson(worktreePath, ['number', 'comments', 'reviews']);
    if (!pr) {
      const empty = { reviews: [], comments: [], threads: [] };
      this.setCache(cacheKey, empty);
      return empty;
    }

    const threads = await this.getReviewThreads(context.repoRoot, context.owner!, context.repo!, pr.number);
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

    this.setCache(cacheKey, conversation);
    return conversation;
  }

  async getPullRequestChecks(worktreePath: string, refresh = false): Promise<PullRequestCheckRollup> {
    const cacheKey = `checks:${worktreePath}`;
    if (!refresh) {
      const cached = this.getCache<PullRequestCheckRollup>(cacheKey);
      if (cached) return cached;
    }

    const summary = await this.findLinkedPullRequest(worktreePath, refresh);
    if (!summary) {
      const empty = {
        summary: { total: 0, passing: 0, failing: 0, pending: 0 },
        checks: [],
      };
      this.setCache(cacheKey, empty);
      return empty;
    }

    const context = await this.repoContextResolver.resolve(worktreePath);
    let stdout = '';
    try {
      stdout = await this.runner.run(
        ['pr', 'checks', String(summary.number), '--repo', `${context.owner}/${context.repo}`, '--json', 'bucket,name,workflow,state,description,link,startedAt,completedAt'],
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
        passing: checks.filter((check: any) => check.bucket === 'pass').length,
        failing: checks.filter((check: any) => check.bucket === 'fail' || check.bucket === 'cancel').length,
        pending: checks.filter((check: any) => check.bucket === 'pending').length,
      },
      checks,
    };

    this.setCache(cacheKey, rollup);
    return rollup;
  }

  async addComment(worktreePath: string, body: string): Promise<{ success: boolean }> {
    const pr = await this.findLinkedPullRequest(worktreePath, true);
    if (!pr) {
      throw new Error('No pull request is linked to this branch.');
    }

    const context = await this.repoContextResolver.resolve(worktreePath);
    await this.runner.run(
      ['pr', 'comment', String(pr.number), '--repo', `${context.owner}/${context.repo}`, '--body', body],
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
    const pr = await this.findLinkedPullRequest(worktreePath, true);
    if (!pr) {
      throw new Error('No pull request is linked to this branch.');
    }

    const context = await this.repoContextResolver.resolve(worktreePath);
    const flags = event === 'APPROVE'
      ? ['--approve']
      : event === 'REQUEST_CHANGES'
        ? ['--request-changes']
        : ['--comment'];

    await this.runner.run(
      ['pr', 'review', String(pr.number), '--repo', `${context.owner}/${context.repo}`, ...flags, '--body', body],
      context.repoRoot,
    );
    this.invalidate(worktreePath);
    return { success: true };
  }

  async push(worktreePath: string): Promise<PushResult> {
    return this.gitService.push(worktreePath);
  }

  invalidate(worktreePath: string): void {
    for (const key of this.cache.keys()) {
      if (key.endsWith(`:${worktreePath}`) || key.includes(worktreePath)) {
        this.cache.delete(key);
      }
    }
  }

  private async findLinkedPullRequest(worktreePath: string, refresh = false): Promise<LinkedPullRequestSummary | null> {
    const cacheKey = `pr-summary:${worktreePath}`;
    if (!refresh) {
      const cached = this.getCache<LinkedPullRequestSummary | null>(cacheKey);
      if (cached !== null) return cached;
    }

    const raw = await this.runPrViewJson(worktreePath, ['number', 'title', 'url', 'state', 'isDraft']);
    const summary = raw ? {
      number: raw.number,
      title: raw.title,
      url: raw.url,
      state: raw.state,
      isDraft: Boolean(raw.isDraft),
    } : null;
    this.setCache(cacheKey, summary);
    return summary;
  }

  private async runPrViewJson(worktreePath: string, fields: string[]): Promise<any | null> {
    const context = await this.repoContextResolver.resolve(worktreePath);
    if (!this.supportsGitHub(context)) {
      return null;
    }

    try {
      const stdout = await this.runner.run(
        ['pr', 'view', context.branch, '--repo', `${context.owner}/${context.repo}`, '--json', fields.join(',')],
        context.repoRoot,
      );
      return JSON.parse(stdout);
    } catch (error) {
      if (error instanceof GhCommandError && /no pull requests found/i.test(error.stderr || error.message)) {
        return null;
      }
      if (error instanceof GhCommandError && /authentication required|not logged into/i.test(`${error.stderr} ${error.stdout} ${error.message}`)) {
        return null;
      }
      throw error;
    }
  }

  private async getReviewThreads(repoRoot: string, owner: string, repo: string, number: number): Promise<PullRequestReviewThread[]> {
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
          '-f', `query=${query}`,
          '-F', `owner=${owner}`,
          '-F', `repo=${repo}`,
          '-F', `number=${number}`,
        ],
        repoRoot,
      );

      const nodes = JSON.parse(stdout)?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
      return nodes.map((thread: any) => ({
        id: thread.id,
        path: thread.path,
        line: typeof thread.line === 'number' ? thread.line : null,
        originalLine: typeof thread.originalLine === 'number' ? thread.originalLine : null,
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
      .map(chunk => chunk.trim())
      .filter(Boolean);

    return chunks.map(chunk => {
      const normalizedChunk = chunk.startsWith('a/') ? `diff --git ${chunk}` : `diff --git ${chunk}`;
      const lines = normalizedChunk.split('\n');
      const header = lines[0] ?? '';
      const match = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const oldPath = match?.[1] ?? null;
      const path = match?.[2] ?? oldPath ?? 'unknown';

      let status: PullRequestFileDiff['status'] = 'modified';
      if (lines.some(line => line.startsWith('new file mode'))) {
        status = 'added';
      } else if (lines.some(line => line.startsWith('deleted file mode'))) {
        status = 'removed';
      } else if (lines.some(line => line.startsWith('rename from '))) {
        status = 'renamed';
      }

      const additions = lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length;
      const deletions = lines.filter(line => line.startsWith('-') && !line.startsWith('---')).length;

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

  private supportsGitHub(context: Awaited<ReturnType<RepoContextResolverService['resolve']>>): boolean {
    return context.host === 'github.com' && Boolean(context.owner && context.repo);
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
      await this.runner.run(['auth', 'status', '--hostname', 'github.com'], repoRoot);
      return true;
    } catch (error) {
      if (error instanceof GhCommandError) {
        return false;
      }
      throw error;
    }
  }

  private getCache<T>(key: string): T | null {
    const value = this.cache.get(key);
    if (!value) return null;
    if (Date.now() - value.createdAt > this.cacheTtlMs) {
      this.cache.delete(key);
      return null;
    }
    return value.data as T;
  }

  private setCache<T>(key: string, data: T): void {
    this.cache.set(key, { data, createdAt: Date.now() });
  }
}
