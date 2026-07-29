import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import { resolveRepo } from './worktree.util.js';

/**
 * delete_worktree — DESTRUCTIVE, mutates. Runs `git worktree remove`, deleting
 * the worktree's directory and stopping any sessions bound to it. 🔴scoped.
 * Irreversible: uncommitted/unpushed work in the worktree is lost. Flagged in
 * agent-tool-policy.ts so "review" autonomy blocks on human approval first.
 */
export const deleteWorktreeTool = defineTool({
  name: 'delete_worktree',
  title: 'Delete worktree',
  costClass: 'scoped',
  mutates: true,
  destructive: true,
  description:
    'DESTRUCTIVE: permanently remove a git worktree from disk (git worktree remove) and stop any sessions bound to it. 🔴. Irreversible — any uncommitted or unpushed work in the worktree is lost. Ask the human for approval (request_approval) before calling this, unless the worktree is confirmed clean and already superseded. Get worktreePath from assess_worktree_pool or project_overview.',
  annotations: { destructiveHint: true },
  inputShape: {
    repoId: z
      .number()
      .int()
      .positive()
      .describe('Repo the worktree belongs to. From add_repo / project_overview.'),
    worktreePath: z
      .string()
      .min(1)
      .describe('Absolute path of the worktree to remove. From assess_worktree_pool or project_overview.'),
  },
  handler: async (args, ctx) => {
    const { worktrees, sessions } = ctx.services;
    const repo = await resolveRepo(ctx, args.repoId);
    const worktreePath = args.worktreePath.trim();

    if (!worktreePath) {
      throw new ToolError({
        code: 'invalid_worktree_path',
        message: 'worktreePath is required.',
        remediation: 'Pass the absolute path of the worktree to remove.',
      });
    }

    // Stop sessions bound to this worktree before the directory disappears.
    await sessions
      .deleteByRepoAndWorktreePath(repo.id, worktreePath)
      .catch(() => {
        // Best-effort — proceed with removal even if session cleanup partially fails.
      });

    try {
      await worktrees.removeWorktree(repo.path, worktreePath);
    } catch (error) {
      throw new ToolError({
        code: 'delete_worktree_failed',
        message: error instanceof Error ? error.message : 'Could not remove worktree.',
        remediation:
          'Verify the worktreePath is correct and not the repo\'s main working tree via assess_worktree_pool.',
      });
    }

    return {
      data: { repoId: repo.id, worktreePath, deleted: true },
      touched: { repoId: repo.id },
      nextStep: 'Confirm removal with assess_worktree_pool.',
    };
  },
});
