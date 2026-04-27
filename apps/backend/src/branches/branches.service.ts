import { BadRequestException, Injectable } from '@nestjs/common';
import simpleGit, { SimpleGit, BranchSummary } from 'simple-git';
import * as fs from 'node:fs';

export interface BranchInfo {
  name: string;
  commit: string;
  label: string;
  current: boolean;
  isRemote: boolean;
  hasWorktree: boolean;
  worktreePath: string | null;
}

@Injectable()
export class BranchesService {
  private cache = new Map<string, { data: BranchInfo[]; timestamp: number }>();
  private readonly CACHE_TTL_MS = 5_000;

  private getCacheKey(repoPath: string, includeRemote: boolean): string {
    return `${repoPath}:${includeRemote}`;
  }

  invalidateCache(repoPath: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(repoPath + ':')) {
        this.cache.delete(key);
      }
    }
  }

  async getBranches(repoPath: string, includeRemote = false): Promise<BranchInfo[]> {
    const cacheKey = this.getCacheKey(repoPath, includeRemote);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      // Use separate SimpleGit instances for true parallelism
      // (simple-git serializes commands per instance)
      const [branchSummary, worktreePaths] = await Promise.all([
        simpleGit(repoPath).branch(includeRemote ? ['-a'] : []) as Promise<BranchSummary>,
        this.listWorktreePaths(simpleGit(repoPath)),
      ]);

      // Normalize repo path for comparison (macOS symlink issue)
      let normalizedRepoPath = repoPath;
      try {
        normalizedRepoPath = await fs.promises.realpath(repoPath);
      } catch { /* ignore */ }

      const branches: BranchInfo[] = [];

      for (const [branchName, info] of Object.entries(branchSummary.branches)) {
        const isRemote = branchName.startsWith('remotes/');

        if (isRemote && !includeRemote) {
          continue;
        }

        const displayName = isRemote
          ? branchName.replace(/^remotes\//, '')
          : branchName;

        if (isRemote) {
          branches.push({
            name: displayName,
            commit: info.commit,
            label: info.label,
            current: false,
            isRemote: true,
            hasWorktree: false,
            worktreePath: null,
          });
          continue;
        }

        let worktreePath = worktreePaths.get(branchName) || null;

        // Normalize worktree path for comparison
        if (worktreePath) {
          try {
            const normalizedWorktreePath = await fs.promises.realpath(worktreePath);
            if (normalizedWorktreePath === normalizedRepoPath) {
              worktreePath = null; // Don't show main repo as a worktree
            }
          } catch { /* ignore */ }
        }

        branches.push({
          name: branchName,
          commit: info.commit,
          label: info.label,
          current: info.current,
          isRemote: false,
          hasWorktree: worktreePath !== null,
          worktreePath,
        });
      }

      this.cache.set(cacheKey, { data: branches, timestamp: Date.now() });
      return branches;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      throw new BadRequestException(
        `Cannot access repository at path: ${repoPath}. ${message}`,
      );
    }
  }

  async searchBranches(
    repoPath: string,
    query: string,
    allowEmpty = false,
  ): Promise<BranchInfo[]> {
    const allBranches = await this.getBranches(repoPath);

    if (!allowEmpty && (!query || query.length < 3)) {
      return [];
    }

    let filtered = allBranches;
    if (query && query.length > 0) {
      const lowerQuery = query.toLowerCase();
      filtered = allBranches.filter((branch) =>
        branch.name.toLowerCase().includes(lowerQuery),
      );
    }

    if (allowEmpty) {
      filtered.sort((a, b) => {
        if (a.current !== b.current) return a.current ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return filtered.slice(0, 100);
    }

    return filtered;
  }

  async searchRemoteBranches(
    repoPath: string,
    query: string,
  ): Promise<BranchInfo[]> {
    const allBranches = await this.getBranches(repoPath, true);
    const remoteBranches = allBranches.filter((b) => b.isRemote);

    let filtered = remoteBranches;
    if (query && query.length > 0) {
      const lowerQuery = query.toLowerCase();
      filtered = remoteBranches.filter((branch) =>
        branch.name.toLowerCase().includes(lowerQuery),
      );
    }

    filtered.sort((a, b) => a.name.localeCompare(b.name));
    return filtered.slice(0, 100);
  }

  async createBranch(
    repoPath: string,
    branchName: string,
    startPoint?: string,
  ): Promise<BranchInfo> {
    try {
      const git: SimpleGit = simpleGit(repoPath);

      this.invalidateCache(repoPath);

      const validName = this.validateBranchName(branchName);
      if (!validName) {
        throw new BadRequestException(
          `Invalid branch name: "${branchName}". Branch names cannot contain spaces, special characters like ~^:?*[\\, or start with a dot or dash.`,
        );
      }

      const existingBranches = await git.branch();
      if (existingBranches.branches[branchName]) {
        throw new BadRequestException(`Branch "${branchName}" already exists`);
      }

      const resolvedStartPoint = startPoint || 'HEAD';
      try {
        await git.raw(['rev-parse', '--verify', resolvedStartPoint]);
      } catch {
        throw new BadRequestException(
          `Invalid start point: "${resolvedStartPoint}" does not exist`,
        );
      }

      await git.branch([branchName, resolvedStartPoint]);

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
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      throw new BadRequestException(
        `Failed to create branch: ${message}`,
      );
    }
  }

  private validateBranchName(name: string): boolean {
    if (!name || name.length === 0) return false;
    if (/^[\.\-]/.test(name)) return false;
    if (/[\s~^:?*\[\\]/.test(name)) return false;
    if (name.includes('..')) return false;
    if (name.endsWith('/')) return false;
    if (name.endsWith('.lock')) return false;
    return true;
  }

  private async listWorktreePaths(git: SimpleGit): Promise<Map<string, string>> {
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