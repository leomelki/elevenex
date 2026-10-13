import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import { taskOperation } from '../setup/task.util.js';

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
    'Page coding conversations in a task, repo, or project. Task scope is cheapest; repo defaults to your current repo. Include archived history explicitly, without reacquiring a checkout. session_status/read_session inspect a conversation.',
  annotations: { readOnlyHint: true },
  currentSessionScope: 'repo',
  inputShape: {
    folderId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Optional session-folder membership filter within the selected task/repo/project scope.',
      ),
    taskId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Scope to one task’s conversations, including finished-task history when state is all/archived. Mutually exclusive with repoId/projectId.',
      ),
    repoId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Scope to one repo (cheapest). Mutually exclusive with projectId.',
      ),
    projectId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Scope to all repos in a project. Used only when repoId is omitted.',
      ),
    status: z
      .enum([
        'created',
        'running',
        'completed',
        'requires_action',
        'failed',
        'stopped',
        'archived',
      ])
      .optional()
      .describe('Optional conversation runtime status filter, applied in SQL.'),
    state: z
      .enum(['active', 'archived', 'all'])
      .default('active')
      .describe(
        'Conversation lifecycle filter, default active. all/archived includes finished-task conversations; use status for runtime state.',
      ),
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
    const { sessions } = ctx.services;

    if (
      [args.repoId, args.projectId, args.taskId].filter(
        (id) => id !== undefined,
      ).length > 1
    ) {
      throw new ToolError({
        code: 'conflicting_scope',
        message: 'Pass only one of taskId, repoId or projectId.',
        remediation:
          'Choose taskId for one task’s conversations, or repoId/projectId for broader discovery.',
      });
    }

    if (args.taskId !== undefined) {
      await taskOperation(() => ctx.services.tasks.record(args.taskId!));
    } else if (args.repoId === undefined && args.projectId === undefined) {
      throw new ToolError({
        code: 'scope_required',
        message: 'find_sessions needs a taskId, repoId or projectId.',
        remediation:
          'Use get_current_session or project_overview to choose scope.',
      });
    }
    const {
      rows: page,
      total,
      nextOffset,
    } = await sessions.listHandlePage(args);
    const truncated = nextOffset !== null;

    return {
      data: {
        total,
        offset: args.offset,
        count: page.length,
        nextOffset,
        sessions: page.map((s) => ({
          id: s.id,
          name: s.name ?? `Session ${s.id}`,
          status: s.status,
          branch: s.branchName,
          provider: s.activeAgentProvider,
          repoId: s.repoId,
          workspaceId: s.workspaceId,
          folderId: s.folderId,
          worktreePath: s.worktreePath,
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
