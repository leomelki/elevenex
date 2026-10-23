import { BadRequestException, Injectable } from '@nestjs/common';
import { SimpleGit } from 'simple-git';
import { worktreeSimpleGit } from '../config/system-paths.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface BranchInfo {
  name: string;
  commit: string;
  label: string;
  current: boolean;
  isRemote: boolean;
  hasWorktree: boolean;
  worktreePath: string | null;
}

/** Lower is better: exact name, name prefix, segment start, then substring.
 * Remote names also match without their `origin/` prefix. Returns -1 when
 * the branch does not contain the (lowercase) query at all.
 */
function branchMatchRank(branch: BranchInfo, query: string): number {
  const name = branch.name.toLowerCase();
  let at = name.indexOf(query);
  if (at < 0) return -1;
  const short = branch.isRemote ? name.slice(name.indexOf('/') + 1) : name;
  if (name === query || short === query) return 0;
  if (at === 0 || short.startsWith(query)) return 1;
  for (; at >= 0; at = name.indexOf(query, at + 1))
    if ('/-_.'.includes(name[at - 1])) return 2;
  return 3;
}

@Injectable()
export class BranchesService {
  private readonly cache = new Map<
    string,
    { data: BranchInfo[]; timestamp: number }
  >();
  private readonly inFlight = new Map<string, Promise<BranchInfo[]>>();
  private readonly MAX_CACHE_ENTRIES = 1_000;
  private readonly CACHE_TTL_MS = 5_000;
  /** How old a listing interactive pickers may show while it refreshes. */
  private readonly STALE_TTL_MS = 60_000;
  private readonly SEARCH_LIMIT = 100;

  invalidateCache(repoPath: string): void {
    const key = path.resolve(repoPath);
    this.inFlight.delete(key);
    this.cache.delete(key);
  }

  /** `allowStale` answers from a listing up to a minute old and refreshes it
   * in the background, so typing in a picker never waits on git.
   */
  async getBranches(
    repoPath: string,
    includeRemote = false,
    { allowStale = false } = {},
  ): Promise<BranchInfo[]> {
    const select = (data: BranchInfo[]) =>
      includeRemote ? data : data.filter((branch) => !branch.isRemote);
    const cached = this.cache.get(path.resolve(repoPath));
    const age = cached ? Date.now() - cached.timestamp : Infinity;
    if (cached && age < this.CACHE_TTL_MS) return select(cached.data);
    if (cached && allowStale && age < this.STALE_TTL_MS) {
      void this.refresh(repoPath).catch(() => undefined);
      return select(cached.data);
    }
    return select(await this.refresh(repoPath));
  }

  /** Local and remote searches share one enumeration, even while a large
   * repository's first read is still running.
   */
  private refresh(repoPath: string): Promise<BranchInfo[]> {
    const key = path.resolve(repoPath);
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.readBranches(repoPath)
        .then((data) => {
          if (this.inFlight.get(key) === pending) {
            this.cache.delete(key);
            this.cache.set(key, { data, timestamp: Date.now() });
            if (this.cache.size > this.MAX_CACHE_ENTRIES) {
              for (const oldestKey of this.cache.keys()) {
                this.cache.delete(oldestKey);
                break;
              }
            }
          }
          return data;
        })
        .finally(() => {
          if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
        });
      this.inFlight.set(key, pending);
    }
    return pending;
  }

  private async readBranches(repoPath: string): Promise<BranchInfo[]> {
    try {
      // `git branch -v` reads every tip commit for its subject, which takes
      // tens of seconds with thousands of remote branches; for-each-ref only
      // reads refs. Separate SimpleGit instances run in parallel (simple-git
      // serializes commands per instance).
      const [refs, worktreePaths, normalizedRepoPath] = await Promise.all([
        worktreeSimpleGit(repoPath).raw([
          'for-each-ref',
          '--format=%(refname)%00%(objectname)%00%(HEAD)%00%(symref)',
          'refs/heads',
          'refs/remotes',
        ]),
        this.listWorktreePaths(worktreeSimpleGit(repoPath)),
        // Normalize repo path for comparison (macOS symlink issue)
        fs.promises.realpath(repoPath).catch(() => repoPath),
      ]);

      // Don't show the main repo as a worktree.
      const mainCheckouts = new Set<string>();
      await Promise.all(
        [...worktreePaths].map(async ([branch, worktreePath]) => {
          const real = await fs.promises
            .realpath(worktreePath)
            .catch(() => worktreePath);
          if (real === normalizedRepoPath) mainCheckouts.add(branch);
        }),
      );

      const branches: BranchInfo[] = [];
      for (const line of refs.split('\n')) {
        const [ref, commit, head, symref] = line.split('\0');
        // Skip blank lines and `origin/HEAD`-style aliases.
        if (!commit || symref) continue;
        const isRemote = ref.startsWith('refs/remotes/');
        const name = ref.slice(isRemote ? 13 : 11);
        const worktreePath =
          isRemote || mainCheckouts.has(name)
            ? null
            : (worktreePaths.get(name) ?? null);
        branches.push({
          name,
          commit,
          label: name,
          current: head === '*',
          isRemote,
          hasWorktree: worktreePath !== null,
          worktreePath,
        });
      }
      return branches;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new BadRequestException(
        `Cannot access repository at path: ${repoPath}. ${message}`,
      );
    }
  }

  /** Best matches first; ties keep git's refname order, shorter names first. */
  private rank(branches: BranchInfo[], query: string): BranchInfo[] {
    const lowerQuery = query.toLowerCase();
    return branches
      .map((branch, index) => ({
        branch,
        index,
        rank: branchMatchRank(branch, lowerQuery),
      }))
      .filter((match) => match.rank >= 0)
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          a.branch.name.length - b.branch.name.length ||
          a.index - b.index,
      )
      .map((match) => match.branch);
  }

  async searchBranches(
    repoPath: string,
    query: string,
    allowEmpty = false,
  ): Promise<BranchInfo[]> {
    query = query?.trim() ?? '';
    if (!allowEmpty && query.length < 3) {
      return [];
    }

    const allBranches = await this.getBranches(repoPath, false, {
      allowStale: true,
    });

    if (query) {
      const ranked = this.rank(allBranches, query);
      return allowEmpty ? ranked.slice(0, this.SEARCH_LIMIT) : ranked;
    }
    return [...allBranches]
      .sort((a, b) => Number(b.current) - Number(a.current))
      .slice(0, this.SEARCH_LIMIT);
  }

  async searchRemoteBranches(
    repoPath: string,
    query: string,
  ): Promise<BranchInfo[]> {
    query = query?.trim() ?? '';
    const remoteBranches = (
      await this.getBranches(repoPath, true, { allowStale: true })
    ).filter((branch) => branch.isRemote);
    return (query ? this.rank(remoteBranches, query) : remoteBranches).slice(
      0,
      this.SEARCH_LIMIT,
    );
  }

  async createBranch(
    repoPath: string,
    branchName: string,
    startPoint?: string,
  ): Promise<BranchInfo> {
    try {
      const git: SimpleGit = worktreeSimpleGit(repoPath);

      this.invalidateCache(repoPath);

      const validName = await this.validateBranchName(git, branchName);
      if (!validName) {
        throw new BadRequestException(
          `Invalid branch name: "${branchName}". Branch names cannot contain spaces, special characters like ~^:?*[\\, or start with a dot or dash.`,
        );
      }

      // `git.branch()` would list every remote branch with its subject.
      const exists = await git
        .raw([
          'rev-parse',
          '--verify',
          '--end-of-options',
          `refs/heads/${branchName}`,
        ])
        .then(
          () => true,
          () => false,
        );
      if (exists) {
        throw new BadRequestException(`Branch "${branchName}" already exists`);
      }

      const resolvedStartPoint = startPoint || 'HEAD';
      try {
        if (resolvedStartPoint.startsWith('-'))
          throw new Error('Invalid revision');
        await git.raw([
          'rev-parse',
          '--verify',
          '--end-of-options',
          resolvedStartPoint,
        ]);
      } catch {
        throw new BadRequestException(
          `Invalid start point: "${resolvedStartPoint}" does not exist`,
        );
      }

      await git.raw(['branch', '--', branchName, resolvedStartPoint]);
      // Listings started during validation or mutation can still contain the
      // old refs. Discard them before reading back the successfully created ref.
      this.invalidateCache(repoPath);

      const branches = await this.getBranches(repoPath);
      const newBranch = branches.find((b) => b.name === branchName);

      if (!newBranch) {
        throw new BadRequestException(
          'Branch was created but could not be found',
        );
      }

      return newBranch;
    } catch (error: unknown) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new BadRequestException(`Failed to create branch: ${message}`);
    }
  }

  private async validateBranchName(
    git: SimpleGit,
    name: string,
  ): Promise<boolean> {
    if (!name || name.startsWith('-')) return false;
    return git.raw(['check-ref-format', '--branch', name]).then(
      // --branch expands checkout shorthand such as @{-1}; callers create a
      // literal branch name, so require Git to validate that exact name.
      (validated) => validated.trim() === name,
      () => false,
    );
  }

  private async listWorktreePaths(
    git: SimpleGit,
  ): Promise<Map<string, string>> {
    const worktreeMap = new Map<string, string>();

    try {
      const output = await git.raw(['worktree', 'list', '--porcelain']);
      const lines = output.split('\n');

      let currentPath: string | null = null;
      let currentBranch: string | null = null;

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          currentPath = line.substring('worktree '.length);
        } else if (line.startsWith('branch ')) {
          const branchRef = line.substring('branch '.length);
          // Extract branch name from refs/heads/branch-name
          if (branchRef.startsWith('refs/heads/')) {
            currentBranch = branchRef.substring('refs/heads/'.length);
          }
        } else if (line === '') {
          // Blank line indicates end of worktree entry
          if (currentPath && currentBranch) {
            worktreeMap.set(currentBranch, currentPath);
          }
          currentPath = null;
          currentBranch = null;
        }
      }

      // Handle last entry if no trailing blank line
      if (currentPath && currentBranch) {
        worktreeMap.set(currentBranch, currentPath);
      }
    } catch {
      // If worktree list fails, return empty map
    }

    return worktreeMap;
  }
}
