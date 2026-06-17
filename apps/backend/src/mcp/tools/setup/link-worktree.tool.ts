import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { linkWorktree } from './link.util.js';

/**
 * link_worktree — mutates. Link a free worktree into this project as a
 * workspace on a branch, creating the workspace if needed. 🟡. If the worktree
 * is owned by another project or dirty, it does NOT auto-confirm — it surfaces
 * the conflict so you escalate to steal_worktree or a human.
 */
export const linkWorktreeTool = defineTool({
  name: 'link_worktree',
  title: 'Link worktree',
  costClass: 'scoped',
  mutates: true,
  description:
    'Link a worktree into this project as a workspace on the given branch (creates the workspace if needed). 🟡scoped. Refuses to take over another project or stash dirty changes — surfaces that so you escalate to steal_worktree or a human. Get worktreeId from assess_worktree_pool.',
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
      .describe('Pool worktree id to link. From assess_worktree_pool.'),
    branchName: z
      .string()
      .min(1)
      .describe('Branch to check out / bind the workspace to.'),
    workspaceName: z
      .string()
      .optional()
      .describe('Optional workspace name. Defaults to the worktree name.'),
  },
  handler: async (args, ctx) => linkWorktree(ctx, args, false),
});
