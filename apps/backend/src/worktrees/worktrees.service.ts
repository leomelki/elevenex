import { BadRequestException, Injectable } from '@nestjs/common';
import { SimpleGit } from 'simple-git';
import { worktreeSimpleGit } from '../config/system-paths.js';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';

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
  ): Promise<WorktreeInfo> {
    const git: SimpleGit = worktreeSimpleGit(repoPath);
    const repoName = path.basename(repoPath);

    // Default path: <parent-dir>/.worktrees/<repo-name>/<branch-name>
    const targetPath =
      worktreePath ||
      path.join(path.dirname(repoPath), '.worktrees', repoName, branchName);

    try {
      await git.raw(['worktree', 'add', targetPath, branchName]);
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
