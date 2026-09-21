import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { linkWorktree } from './link.util.js';

/**
 * steal_worktree — DESTRUCTIVE, mutates. Takes over a worktree currently owned
 * by ANOTHER project (confirmTakeover), unlinking its workspace and stopping
 * its sessions. 🔴. Only after link_worktree reported an ownership conflict and
 * you have decided to seize it.
 */
export const stealWorktreeTool = defineTool({
  name: 'steal_worktree',
  title: 'Steal worktree',
  costClass: 'scoped',
  mutates: true,
  destructive: true,
  description:
    'DESTRUCTIVE: take over a worktree owned by another project (unlinks its workspace and stops its sessions). 🔴. Use only after link_worktree reported an ownership conflict and you intend to seize it. Get worktreeId from assess_worktree_pool. ' +
    "You're seizing this worktree from whatever it was doing before. If it lacks the repo's stable numbered pattern, call rename_worktree and use <repo> 1, <repo> 2, and so on; use a project-scoped name only when the human prefers worktrees per project.",
  annotations: { destructiveHint: true },
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
      .describe('Pool worktree id to take over. From assess_worktree_pool.'),
    branchName: z
      .string()
      .min(1)
      .describe('Branch to check out / bind the workspace to.'),
    workspaceName: z
      .string()
      .optional()
      .describe('Optional workspace name. Defaults to the worktree name.'),
  },
  handler: async (args, ctx) => linkWorktree(ctx, args, true),
});
