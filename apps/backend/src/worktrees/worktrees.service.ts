import { BadRequestException, Injectable } from '@nestjs/common';
import { SimpleGit } from 'simple-git';
import { worktreeSimpleGit } from '../config/system-paths.js';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';

export interface BranchLastCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}

export interface BranchSnapshot {
  /** Commits the local branch is ahead of origin/<branch>. */
  ahead: number;
  /** Commits origin/<branch> is ahead of the local branch. */
  behind: number;
  headSha: string | null;
  lastCommit: BranchLastCommit | null;
  /** Whether origin/<branch> exists. */
  remoteExists: boolean;
}

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
  isDetached: boolean;
  isBare: boolean;
  isLocked: boolean;
  lockReason: string | null;
}

export interface ListWorktreesOptions {
  prune?: boolean;
}

@Injectable()
export class WorktreesService {
  async listWorktrees(
    repoPath: string,
    options: ListWorktreesOptions = {},
  ): Promise<WorktreeInfo[]> {
    const git: SimpleGit = worktreeSimpleGit(repoPath);

    if (options.prune) {
      try {
        await git.raw(['worktree', 'prune']);
      } catch {
        // Ignore prune errors
      }
    }

    const output = await git.raw(['worktree', 'list', '--porcelain']);
    return this.parsePorcelainOutput(output);
  }

  async createWorktree(
    repoPath: string,
    branchName: string,
    worktreePath?: string,
    startPoint?: string,
  ): Promise<WorktreeInfo> {
    const git: SimpleGit = worktreeSimpleGit(repoPath);
    const repoName = path.basename(repoPath);

    // Default path: <parent-dir>/.worktrees/<repo-name>/<branch-name>
    const targetPath =
      worktreePath ||
      path.join(path.dirname(repoPath), '.worktrees', repoName, branchName);

    const base = startPoint?.trim();
    const branchExists = await this.localBranchExistsWithGit(git, branchName);

    try {
      if (branchExists) {
        // Existing local branch: check it out in the new worktree. An explicit
        // startPoint is ignored here — the branch already has its own tip.
        await git.raw(['worktree', 'add', targetPath, branchName]);
      } else if (base) {
        // Branch does not exist yet: create it in the worktree from the given
        // base ref (e.g. origin/main) using `git worktree add -b`.
        await git.raw(['worktree', 'add', '-b', branchName, targetPath, base]);
      } else {
        // No base ref given. First let git DWIM a remote-tracking branch when
        // one matches the name; if no such ref exists, create a fresh branch
        // from the repo's current HEAD instead of failing.
        try {
          await git.raw(['worktree', 'add', targetPath, branchName]);
        } catch {
          await git.raw(['worktree', 'add', '-b', branchName, targetPath]);
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new BadRequestException(`Failed to create worktree: ${message}`);
    }

    // Re-list to get the created worktree info
    // Use realpath for comparison (macOS symlink issue)
    const realTargetPath = await this.realPathOrRaw(targetPath);
    const worktrees = await this.listWorktrees(repoPath);
    let created: WorktreeInfo | undefined;
    for (const worktree of worktrees) {
      if ((await this.realPathOrRaw(worktree.path)) === realTargetPath) {
        created = worktree;
        break;
      }
    }

    if (!created) {
      throw new BadRequestException(
        'Worktree was created but could not be found in list',
      );
    }

    return created;
  }

  async moveWorktree(
    repoPath: string,
    worktreePath: string,
    newWorktreePath: string,
  ): Promise<void> {
    const git: SimpleGit = worktreeSimpleGit(repoPath);
    // `git worktree move` refuses to create leading directories (unlike
    // `git worktree add`), so moving a worktree that lives outside
    // `.worktrees/<repo>/` into it fails with a bare ENOENT. Create the parent
    // ourselves first.
    await fs.mkdir(path.dirname(newWorktreePath), { recursive: true });
    try {
      await git.raw(['worktree', 'move', worktreePath, newWorktreePath]);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new BadRequestException(`Failed to move worktree: ${message}`);
    }
  }

  async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    // Use realpath for comparison (macOS symlink issue)
    let normalizedRepoPath = repoPath;
    let normalizedWorktreePath = worktreePath;

    try {
      normalizedRepoPath = await this.realPathOrRaw(repoPath);
    } catch {
      /* ignore */
    }
    normalizedWorktreePath = await this.realPathOrRaw(worktreePath);

    if (normalizedWorktreePath === normalizedRepoPath) {
      throw new BadRequestException('Cannot remove the main working tree');
    }

    const git: SimpleGit = worktreeSimpleGit(repoPath);

    try {
      await git.raw(['worktree', 'remove', worktreePath]);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new BadRequestException(`Failed to remove worktree: ${message}`);
    }
  }

  async localBranchExists(repoPath: string, branchName: string): Promise<boolean> {
    return this.localBranchExistsWithGit(worktreeSimpleGit(repoPath), branchName);
  }

  /**
   * Resolve the repo's default branch by reading `refs/remotes/origin/HEAD`.
   * Returns a short remote ref such as `"origin/main"`, or `null` when the
   * symbolic ref is absent (shallow clone, no fetch yet, or no remote).
   */
  async getDefaultBranch(repoPath: string): Promise<string | null> {
    const git = worktreeSimpleGit(repoPath);
    try {
      const out = (
        await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD'])
      ).trim();
      // out is e.g. "refs/remotes/origin/main" → strip "refs/remotes/"
      return out.startsWith('refs/remotes/') ? out.slice('refs/remotes/'.length) : out || null;
    } catch {
      return null;
    }
  }

  async remoteBranchExists(repoPath: string, branchName: string): Promise<boolean> {
    const git = worktreeSimpleGit(repoPath);
    try {
      const out = await git.raw(['show-ref', '--verify', `refs/remotes/origin/${branchName}`]);
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Fetch a branch from origin.
   * When `createLocal` is true (branch has no local ref yet), uses the
   * refspec `branchName:branchName` so git creates a local tracking branch.
   * When false, fetches just the remote tracking ref.
   */
  async fetchBranch(repoPath: string, branchName: string, createLocal: boolean): Promise<void> {
    const git = worktreeSimpleGit(repoPath);
    try {
      if (createLocal) {
        await git.raw(['fetch', 'origin', `${branchName}:${branchName}`]);
      } else {
        await git.raw(['fetch', 'origin', branchName]);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new BadRequestException(`Failed to fetch branch from origin: ${message}`);
    }
  }

  /**
   * True when `worktreePath` is the repo's own main working tree. Callers that
   * tear down state before removing a worktree must check this up front:
   * removeWorktree refuses the main tree, but by then the teardown has already
   * happened and cannot be undone.
   */
  async isMainWorktree(
    repoPath: string,
    worktreePath: string,
  ): Promise<boolean> {
    return (
      (await this.realPathOrRaw(repoPath)) ===
      (await this.realPathOrRaw(worktreePath))
    );
  }

  /**
   * Create a local branch ref from a start point WITHOUT checking it out
   * anywhere. Needed when an existing worktree is being reused for a brand-new
   * branch: reuse checks the branch out with a plain `git checkout`, which
   * fails on a branch that has no ref yet, so the ref has to exist first.
   */
  async createLocalBranch(
    repoPath: string,
    branchName: string,
    startPoint: string,
  ): Promise<void> {
    const git = worktreeSimpleGit(repoPath);
    try {
      await git.raw(['branch', branchName, startPoint]);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new BadRequestException(`Failed to create branch: ${message}`);
    }
  }

  /**
   * Return ahead/behind counts vs origin and the tip commit for a local branch.
   * Does not require the branch to be checked out in a worktree.
   */
  async getBranchSnapshot(repoPath: string, branchName: string): Promise<BranchSnapshot> {
    const git = worktreeSimpleGit(repoPath);

    let headSha: string | null = null;
    let lastCommit: BranchLastCommit | null = null;
    try {
      headSha = (await git.raw(['rev-parse', branchName])).trim() || null;
      if (headSha) {
        const log = await git.log({ from: branchName, maxCount: 1 });
        const latest = log.latest;
        if (latest) {
          lastCommit = {
            hash: latest.hash,
            shortHash: latest.hash.slice(0, 7),
            message: latest.message,
            author: latest.author_name,
            date: latest.date,
          };
        }
      }
    } catch { /* branch tip unresolvable */ }

    const remoteRef = `origin/${branchName}`;
    let ahead = 0;
    let behind = 0;
    let remoteExists = false;
    try {
      await git.raw(['rev-parse', '--verify', `refs/remotes/${remoteRef}`]);
      remoteExists = true;
      const counts = (
        await git.raw(['rev-list', '--left-right', '--count', `${branchName}...${remoteRef}`])
      ).trim();
      const [aheadStr, behindStr] = counts.split(/\s+/);
      ahead = Number(aheadStr) || 0;
      behind = Number(behindStr) || 0;
    } catch { /* remote ref unavailable */ }

    return { ahead, behind, headSha, lastCommit, remoteExists };
  }

  private async localBranchExistsWithGit(
    git: SimpleGit,
    branchName: string,
  ): Promise<boolean> {
    try {
      // `show-ref --verify` prints the resolved sha when the local branch ref
      // exists and exits non-zero (which simple-git throws on) otherwise. We
      // avoid `--quiet`: it suppresses output AND the error exit, so simple-git
      // would resolve with an empty string and we could not tell the two apart.
      const out = await git.raw(['show-ref', '--verify', `refs/heads/${branchName}`]);
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  private parsePorcelainOutput(output: string): WorktreeInfo[] {
    const worktrees: WorktreeInfo[] = [];
    const blocks = output.split('\n\n');

    for (const block of blocks) {
      if (!block.trim()) continue;

      const lines = block.split('\n');
      const worktree: Partial<WorktreeInfo> = {
        isDetached: false,
        isBare: false,
        isLocked: false,
        lockReason: null,
      };

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          worktree.path = line.substring('worktree '.length);
        } else if (line.startsWith('HEAD ')) {
          worktree.head = line.substring('HEAD '.length);
        } else if (line.startsWith('branch ')) {
          const branchRef = line.substring('branch '.length);
          // Strip refs/heads/ prefix
          if (branchRef.startsWith('refs/heads/')) {
            worktree.branch = branchRef.substring('refs/heads/'.length);
          } else {
            worktree.branch = branchRef;
          }
        } else if (line === 'detached') {
          worktree.isDetached = true;
        } else if (line === 'bare') {
          worktree.isBare = true;
        } else if (line.startsWith('locked')) {
          worktree.isLocked = true;
          const reason = line.substring('locked'.length).trim();
          worktree.lockReason = reason || null;
        }
      }

      if (worktree.path && worktree.head) {
        worktrees.push(worktree as WorktreeInfo);
      }
    }

    return worktrees;
  }

  private async realPathOrRaw(value: string): Promise<string> {
    try {
      return await fs.realpath(value);
    } catch {
      return path.resolve(value);
    }
  }
}
