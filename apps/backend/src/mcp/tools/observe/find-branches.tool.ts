import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveRepo } from '../setup/worktree.util.js';

export const findBranchesTool = defineTool({
  name: 'find_branches',
  title: 'Find branch refs',
  costClass: 'cached',
  paginated: true,
  requiresQuery: true,
  currentSessionScope: 'repo',
  annotations: { readOnlyHint: true },
  description:
    'Search cached local and remote-tracking branch refs by name, returning fully qualified refs for create_task. No fetch or checkout. Results may be briefly stale; Tasks refreshes remote refs when preparing work.',
  inputShape: {
    repoId: z
      .number()
      .int()
      .positive()
      .describe('Repository ID from get_current_session or project_overview.'),
    query: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .describe('Specific branch-name fragment; broad wildcards are rejected.'),
    kind: z
      .enum(['local', 'remote', 'all'])
      .default('all')
      .describe('Ref kind, default all.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Page size, 1-100; default 20.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Page offset, default 0.'),
  },
  handler: async (args, ctx) => {
    const repo = await resolveRepo(ctx, args.repoId);
    const query = args.query.toLowerCase();
    const rows = (
      await ctx.services.branches.getBranches(repo.path, args.kind !== 'local')
    )
      .filter(
        (branch) =>
          branch.name.toLowerCase().includes(query) &&
          (args.kind === 'all' || branch.isRemote === (args.kind === 'remote')),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    const selected = rows.slice(args.offset, args.offset + args.limit);
    const nextOffset =
      args.offset + selected.length < rows.length
        ? args.offset + selected.length
        : null;
    return {
      data: {
        repoId: repo.id,
        total: rows.length,
        nextOffset,
        branches: selected.map((branch) => ({
          name: branch.name,
          ref: `refs/${branch.isRemote ? 'remotes' : 'heads'}/${branch.name}`,
          isRemote: branch.isRemote,
          commit: branch.commit,
          checkedOutPath: branch.worktreePath,
        })),
      },
      truncated: nextOffset !== null,
      nextStep:
        'create_task with mode:"existing" and a returned ref. For a branch already occupied by another task, use checkoutMode:"snapshot" for isolated review.',
    };
  },
});
