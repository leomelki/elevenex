import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';

/**
 * find_sessions — paginated, scoped session listing. ⚡instant DB read. Scope
 * by repoId (cheapest) or projectId; optionally filter by status. Returns
 * compact handles only — zoom into one with session_status / read_session.
 */
export const findSessionsTool = defineTool({
  name: 'find_sessions',
  title: 'Find sessions',
  costClass: 'instant',
  paginated: true,
  description:
    'List sessions as compact handles, scoped by repoId (cheapest) or projectId, optionally filtered by status. ⚡instant, paginated. Use after project_overview to drill in; then session_status to poll one or read_session to read its transcript.',
  annotations: { readOnlyHint: true },
  inputShape: {
    repoId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Scope to one repo (cheapest). Mutually exclusive with projectId.'),
    projectId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Scope to all repos in a project. Used only when repoId is omitted.'),
    status: z
      .enum(['created', 'running', 'completed', 'requires_action', 'failed', 'stopped'])
      .optional()
      .describe('Optional status filter applied in-memory.'),
    needsReviewOnly: z
      .boolean()
      .default(false)
      .describe('Only sessions with an unreviewed completion. Default false.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Max sessions to return (1-100). Default 25.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Pagination offset for paging past `limit`. Default 0.'),
  },
  handler: async (args, ctx) => {
    const { repos, sessions } = ctx.services;

    let scoped: Awaited<ReturnType<typeof sessions.findByRepo>>;
    if (args.repoId !== undefined) {
      scoped = await sessions.findByRepo(args.repoId);
    } else if (args.projectId !== undefined) {
      const repoList = await repos.findByProject(args.projectId);
      const perRepo = await Promise.all(
        repoList.map((r) => sessions.findByRepo(r.id)),
      );
      scoped = perRepo.flat();
    } else {
      throw new ToolError({
        code: 'scope_required',
        message: 'find_sessions needs a repoId or projectId to bound the query.',
        remediation: 'Pass repoId (preferred) or projectId. Get ids from project_overview.',
      });
    }

    let filtered = scoped;
    if (args.status) filtered = filtered.filter((s) => s.status === args.status);
    if (args.needsReviewOnly)
      filtered = filtered.filter((s) => s.hasUnreviewedCompletion);

    // Newest activity first for a useful default ordering.
    filtered.sort((a, b) =>
      (b.lastStateChangeAt ?? '').localeCompare(a.lastStateChangeAt ?? ''),
    );

    const total = filtered.length;
    const page = filtered.slice(args.offset, args.offset + args.limit);
    const truncated = args.offset + page.length < total;

    return {
      data: {
        total,
        offset: args.offset,
        count: page.length,
        sessions: page.map((s) => ({
          id: s.id,
          name: s.name ?? `Session ${s.id}`,
          status: s.status,
          branch: s.branchName,
          provider: s.activeAgentProvider,
          needsReview: s.hasUnreviewedCompletion,
          lastActivityAt: s.lastStateChangeAt ?? undefined,
          deepLink: ctx.deepLink.session(s.id),
        })),
      },
      truncated,
      nextStep: truncated
        ? 'More results: re-call with offset += limit, or narrow with status/needsReviewOnly.'
        : 'Poll one with session_status, or read its transcript with read_session.',
    };
  },
});
