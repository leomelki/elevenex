import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';

/**
 * remove_repo — detach a repo from its project (bookkeeping, not destructive to
 * the worktree on disk). ⚡instant. Use to undo an add_repo.
 */
export const removeRepoTool = defineTool({
  name: 'remove_repo',
  title: 'Remove repo',
  costClass: 'instant',
  mutates: true,
  description:
    'Detach a repository from its project (removes the elevenex record; leaves the folder on disk). ⚡instant. Reverses add_repo.',
  inputShape: {
    repoId: z
      .number()
      .int()
      .positive()
      .describe('Repo to detach from its project.'),
  },
  handler: async (args, ctx) => {
    const { repos } = ctx.services;
    try {
      await repos.remove(args.repoId);
    } catch (error) {
      throw new ToolError({
        code: 'remove_repo_failed',
        message: error instanceof Error ? error.message : 'Could not remove repo.',
        remediation: 'Verify the repoId exists via project_overview.',
      });
    }
    return {
      data: { repoId: args.repoId, removed: true },
      touched: { repoId: args.repoId },
      nextStep: 'Confirm with project_overview.',
    };
  },
});
