import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import type { WorktreePoolItem } from '../../../worktrees/worktree-pool.service.js';
import {
  matchesCategory,
  poolItemHandle,
  resolveRepo,
} from './worktree.util.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * assess_worktree_pool — list a repo's worktrees as compact handles, scoped by
 * category and capped to bound the git-status hotspot. 🟢cached. Scope to
 * 'available' to find a free worktree to reuse; 'yours' for ones a project
 * already owns. Next: link_worktree (reuse), create_worktree (new), or
 * steal_worktree (take from another project).
 */
export const assessWorktreePoolTool = defineTool({
  name: 'assess_worktree_pool',
  title: 'Assess worktree pool',
  costClass: 'cached',
  paginated: true,
  description:
    "List a repo's worktrees as compact handles, scoped by category and capped (the git-status scan is expensive — always scope). 🟢cached. Use 'available' to find a free worktree, 'yours' for owned ones. " +
    'Judge reusability from the flags, not the names: a worktree with isDirty/hasConflicts/isLocked/isMissing false and activeSessionCount 0 is free to take whatever branch it holds or task it was made for, because rename_worktree + switch_branch reset it. ' +
    'Next: link_worktree to reuse, create_worktree for a new one, or steal_worktree to take an owned one.',
  annotations: { readOnlyHint: true },
  inputShape: {
    repoId: z
      .number()
      .int()
      .positive()
      .describe('Repo whose worktree pool to inspect. From add_repo / project_overview.'),
    category: z
      .enum(['available', 'yours', 'all'])
      .default('available')
      .describe(
        "Scope to reduce cost: 'available' (unowned, free to take), 'yours' (owned by a project), 'all'. Default 'available'.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .describe(`Max worktrees to return (1-${MAX_LIMIT}). Default ${DEFAULT_LIMIT}. Caps the hotspot.`),
  },
  handler: async (args, ctx) => {
    const { worktreePool } = ctx.services;
    const repo = await resolveRepo(ctx, args.repoId);
    const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    const collected: WorktreePoolItem[] = [];
    let matchedTotal = 0;
    // Stream and stop collecting once we have `limit` matches — but we still
    // observe every item streamed to know whether more matches exist.
    await worktreePool.streamForRepo(repo, (item) => {
      if (!matchesCategory(item, args.category)) return;
      matchedTotal += 1;
      if (collected.length < limit) collected.push(item);
    });

    const truncated = matchedTotal > collected.length;

    return {
      data: {
        repoId: repo.id,
        category: args.category,
        count: collected.length,
        matchedTotal,
        worktrees: collected.map(poolItemHandle),
      },
      truncated,
      nextStep: truncated
        ? 'More worktrees match: raise limit or narrow category. To act: link_worktree, create_worktree, or steal_worktree.'
        : 'Prefer reusing: link_worktree for a clean unowned one, steal_worktree for a clean idle owned one (then rename_worktree). create_worktree only when none is reusable.',
    };
  },
});
