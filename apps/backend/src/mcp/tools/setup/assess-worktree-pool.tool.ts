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

/** Optional pool inspection for selecting environment:existing. Tasks owns allocation. */
export const assessWorktreePoolTool = defineTool({
  name: 'assess_worktree_pool',
  title: 'Assess worktree pool',
  costClass: 'cached',
  paginated: true,
  description:
    'Inspect a bounded worktree pool page to select an explicit environment for create_task/retry_task. Prefer automatic allocation. Assigned checkouts belong to tasks even with zero running agents; never take them over. The allocator rechecks ownership, dirtiness, running processes, and limits.',
  currentSessionScope: 'repo',
  annotations: { readOnlyHint: true },
  inputShape: {
    repoId: z
      .number()
      .int()
      .positive()
      .describe(
        'Repo whose worktree pool to inspect. From add_repo / project_overview.',
      ),
    category: z
      .enum(['available', 'assigned', 'yours', 'all'])
      .default('available')
      .describe(
        "Scope to reduce cost: 'available' (unowned, free to take), 'assigned' (owned by a task), 'all'; 'yours' is a compatibility alias for assigned. Default 'available'.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .describe(
        `Max worktrees to return (1-${MAX_LIMIT}). Default ${DEFAULT_LIMIT}. Caps the hotspot.`,
      ),
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
      nextStep:
        'Use create_task or retry_task with environment:existing and a worktreeId only when explicitly choosing a checkout. Otherwise let automatic allocation choose. An assigned task can be opened with get_task; independent review uses snapshot.',
    };
  },
});
