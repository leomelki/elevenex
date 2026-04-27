import { BadRequestException, Injectable } from '@nestjs/common';
import simpleGit, { SimpleGit } from 'simple-git';
import * as path from 'node:path';
import * as fs from 'node:fs';

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
  isDetached: boolean;
  isBare: boolean;
  isLocked: boolean;
  lockReason: string | null;
}

@Injectable()
export class WorktreesService {
  async listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    const git: SimpleGit = simpleGit(repoPath);

    // Prune stale worktree references first
    try {
      await git.raw(['worktree', 'prune']);
    } catch {
      // Ignore prune errors
    }

    const output = await git.raw(['worktree', 'list', '--porcelain']);
    return this.parsePorcelainOutput(output);
  }

  async createWorktree(
    repoPath: string,
    branchName: string,
    worktreePath?: string,
  ): Promise<WorktreeInfo> {
    const git: SimpleGit = simpleGit(repoPath);
    const repoName = path.basename(repoPath);

    // Default path: <parent-dir>/.worktrees/<repo-name>/<branch-name>
    const targetPath =
      worktreePath ||
      path.join(path.dirname(repoPath), '.worktrees', repoName, branchName);

    try {
      await git.raw(['worktree', 'add', targetPath, branchName]);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      throw new BadRequestException(
        `Failed to create worktree: ${message}`,
      );
    }

    // Re-list to get the created worktree info
    // Use realpath for comparison (macOS symlink issue)
    const realTargetPath = fs.realpathSync(targetPath);
    const worktrees = await this.listWorktrees(repoPath);
    const created = worktrees.find((w) => {
      try {
        return fs.realpathSync(w.path) === realTargetPath;
      } catch {
        return w.path === targetPath;
      }
    });

    if (!created) {
      throw new BadRequestException(
        'Worktree was created but could not be found in list',
      );
    }

    return created;
  }

  async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    // Use realpath for comparison (macOS symlink issue)
    let normalizedRepoPath = repoPath;
    let normalizedWorktreePath = worktreePath;
    
    try {
      normalizedRepoPath = fs.realpathSync(repoPath);
    } catch { /* ignore */ }
    
    try {
      normalizedWorktreePath = fs.realpathSync(worktreePath);
    } catch { /* ignore */ }

    if (normalizedWorktreePath === normalizedRepoPath) {
      throw new BadRequestException('Cannot remove the main working tree');
    }

    const git: SimpleGit = simpleGit(repoPath);

    try {
      await git.raw(['worktree', 'remove', worktreePath]);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      throw new BadRequestException(
        `Failed to remove worktree: ${message}`,
      );
    }
  }

  private parsePorcelainOutput(output: string): WorktreeInfo[] {
    const worktrees: WorktreeInfo[] = [];
    const blocks = output.split('\n\n');

    for (const block of blocks) {
      if (!block.trim()) continue;

      const lines = block.split('\n');
      let worktree: Partial<WorktreeInfo> = {
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
}
