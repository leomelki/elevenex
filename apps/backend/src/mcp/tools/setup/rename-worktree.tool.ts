import { z } from 'zod';
import { BadRequestException } from '@nestjs/common';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import { poolItemHandle, resolveRepo } from './worktree.util.js';

/**
 * rename_worktree — mutates. Physically moves a pool worktree to
 * `.worktrees/<repo>/<slug(name)>` and updates its pool record, any workspace
 * currently linked to it, and its generated context row. Use this to establish
 * or restore the repo's stable numbered naming pattern after creating, linking,
 * or stealing a worktree.
 */
export const renameWorktreeTool = defineTool({
  name: 'rename_worktree',
  title: 'Rename worktree',
  costClass: 'scoped',
  mutates: true,
  description:
    'Rename a pool worktree: moves its directory to .worktrees/<repo>/<slug(name)> (git worktree move) and repoints everything keyed on the old path — pool record, linked workspace (name included), sessions, terminals, actions and context row. 🟡scoped. ' +
    'Use stable, project-agnostic names by default: <repo> 1, <repo> 2, and so on, choosing the lowest available positive number. Do not name a reusable worktree after its current branch, ticket, feature, or project. ' +
    'If the human explicitly prefers separate worktrees per project, honor that preference with a clear project-scoped name. Get worktreeId from assess_worktree_pool.',
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
        'New stable worktree name. Default to <repo> <number> (for example "elevenex 1"); use a project-scoped name only when the human prefers worktrees per project.',
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
            "Pick a different name, or verify the worktreeId via assess_worktree_pool — the worktree may be locked, missing, the repo's main working tree (which cannot be moved), or the name may collide with an existing directory.",
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
