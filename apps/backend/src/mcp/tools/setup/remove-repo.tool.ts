import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';

/**
 * remove_repo — detach a repo from its project (bookkeeping, not destructive to
 * the worktree on disk). ⚡instant. Use to undo an add_repo.
 */
export const removeRepoTool = defineTool({
  name: 'remove_repo',
  title: 'Remove repo',
  costClass: 'heavy',
  mutates: true,
  destructive: true,
  disallowSelfTarget: 'repo',
  description:
    'Permanently remove a repository and its task/conversation history after stopping session runtimes. Finish active tasks first so preparation and checkout processes are cleaned up. Leaves files on disk. Irreversible; cannot remove the caller’s own repository.',
  inputShape: {
    repoId: z
      .number()
      .int()
      .positive()
      .describe('Repo to detach from its project.'),
  },
  handler: async (args, ctx) => {
    const { repos } = ctx.services;
    repos.assertTaskHistoryCanBeDeleted(args.repoId);
    try {
      await ctx.services.sessions.archiveAllByRepo(args.repoId, true);
      ctx.signal.throwIfAborted();
      await repos.remove(args.repoId, { requireFinishedTasks: true });
    } catch (error) {
      throw new ToolError({
        code: 'remove_repo_failed',
        message:
          error instanceof Error ? error.message : 'Could not remove repo.',
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
