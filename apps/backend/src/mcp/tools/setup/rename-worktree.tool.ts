import { z } from 'zod';
import { BadRequestException } from '@nestjs/common';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import { poolItemHandle, resolveRepo } from './worktree.util.js';

/**
 * rename_worktree — mutates. Physically moves a pool worktree to
 * `.worktrees/<repo>/<slug(name)>` and updates its pool record, any workspace
 * currently linked to it, and its generated context row. Use this whenever a
 * worktree's on-disk name still reflects whatever it was created or last used
 * for — most commonly right after link_worktree/steal_worktree hands you one
 * that isn't yours: give it your own name instead of inheriting its history.
 */
export const renameWorktreeTool = defineTool({
  name: 'rename_worktree',
  title: 'Rename worktree',
  costClass: 'scoped',
  mutates: true,
  description:
    "Rename a pool worktree: moves its directory to .worktrees/<repo>/<slug(name)> (git worktree move) and updates its pool record, linked workspace, and context row to match. 🟡scoped. " +
    'Use this whenever you take over or reuse an existing worktree (via link_worktree or steal_worktree) — treat it as a brand-new worktree with an identity of its own, not a continuation of whatever branch/task it previously held. ' +
    "Give it a name for what YOU are about to do with it, not the branch it currently happens to hold. Get worktreeId from assess_worktree_pool.",
  inputShape: {
    repoId: z
      .number()
      .int()
      .positive()
      .describe('Repo the worktree belongs to.'),
    worktreeId: z
      .number()
      .int()
      .positive()
      .describe('Pool worktree id to rename. From assess_worktree_pool.'),
    name: z
      .string()
      .min(1)
      .describe(
        'New name for the worktree, decorrelated from the branch it holds — task/workspace-based (e.g. "fix-login-timeout"), not a copy of branchName.',
      ),
  },
  handler: async (args, ctx) => {
    const { worktreePool } = ctx.services;
    const repo = await resolveRepo(ctx, args.repoId);
    const name = args.name.trim();

    if (!name) {
      throw new ToolError({
        code: 'invalid_name',
        message: 'name is required.',
        remediation: 'Pass a non-empty new name for the worktree.',
      });
    }

    try {
      const item = await worktreePool.rename(repo, args.worktreeId, name);
      return {
        data: { worktree: poolItemHandle(item) },
        touched: { worktreeId: item.id },
        deepLink: ctx.deepLink.project(repo.projectId),
        nextStep: 'Worktree renamed — proceed with link_worktree/steal_worktree, or use it directly if already linked.',
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw new ToolError({
          code: 'rename_failed',
          message: error.message,
          remediation:
            'Pick a different name, or verify the worktreeId via assess_worktree_pool — the worktree may be locked, missing, or the name may collide with an existing directory.',
          retryable: false,
        });
      }
      throw new ToolError({
        code: 'rename_failed',
        message: error instanceof Error ? error.message : 'Could not rename worktree.',
        remediation: 'Verify the worktreeId via assess_worktree_pool.',
      });
    }
  },
});
