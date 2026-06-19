import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';

/**
 * Compact session handle — the only session shape lists/overviews ever return.
 * Deep content (transcript, diff) is fetched on demand via read_session etc.
 */
function sessionHandle(
  s: {
    id: number;
    name: string | null;
    status: string;
    branchName: string;
    worktreePath: string;
    activeAgentProvider: string;
    hasUnreviewedCompletion: boolean;
    lastCompletionAt: string | null;
  },
  deepLink: string,
) {
  return {
    id: s.id,
    name: s.name ?? `Session ${s.id}`,
    status: s.status,
    branch: s.branchName,
    provider: s.activeAgentProvider,
    needsReview: s.hasUnreviewedCompletion,
    lastCompletionAt: s.lastCompletionAt ?? undefined,
    deepLink,
  };
}

/**
 * project_overview — one aggregate read to orient before doing anything else.
 * ⚡ instant. Without `projectId`: the project list with repo counts and an
 * attention summary. With `projectId`: that project's repos plus their session
 * handles. Replaces many list_* round-trips — start here.
 */
export const projectOverviewTool = defineTool({
  name: 'project_overview',
  title: 'Project overview',
  costClass: 'instant',
  description:
    'Aggregate snapshot to orient yourself: pass nothing for the project list + attention counts, or a projectId to expand that project (repos + compact session handles). Start here before list_* calls. ⚡instant. Next: find_sessions to page sessions, or session_status to poll one.',
  annotations: { readOnlyHint: true },
  inputShape: {
    projectId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Expand this project (repos + sessions). Omit for the project list.'),
    state: z
      .enum(['active', 'archived', 'all'])
      .default('active')
      .describe("Which projects to list when projectId is omitted. Default 'active'."),
  },
  handler: async (args, ctx) => {
    const { projects, repos, sessions } = ctx.services;

    if (args.projectId !== undefined) {
      const project = await projects.findOne(args.projectId).catch(() => null);
      if (!project) {
        throw new ToolError({
          code: 'project_not_found',
          message: `No project with id ${args.projectId}.`,
          remediation: 'Call project_overview with no projectId to list valid ids.',
        });
      }
      const repoList = await repos.findByProject(project.id);
      const repoSummaries = await Promise.all(
        repoList.map(async (repo) => {
          const repoSessions = await sessions.findByRepo(repo.id);
          return {
            id: repo.id,
            name: repo.name,
            path: repo.path,
            sessions: repoSessions.map((s) =>
              sessionHandle(s, ctx.deepLink.session(s.id)),
            ),
          };
        }),
      );
      return {
        data: {
          project: {
            id: project.id,
            name: project.name,
            ...(project.agentInstructions
              ? { agentInstructions: project.agentInstructions }
              : {}),
          },
          repos: repoSummaries,
        },
        deepLink: ctx.deepLink.project(project.id),
        nextStep:
          'Use find_sessions for paging, or session_status / await_session_event to watch a session.',
      };
    }

    const projectList = await projects.findAll(args.state);
    const completion = await sessions.findAllCompletionStates();
    const needsReview = completion.filter((c) => c.hasUnreviewedCompletion).length;
    const overview = await Promise.all(
      projectList.map(async (p) => ({
        id: p.id,
        name: p.name,
        archived: p.archivedAt !== null,
        repoCount: await repos.countByProject(p.id),
        deepLink: ctx.deepLink.project(p.id),
      })),
    );
    return {
      data: {
        projects: overview,
        attention: { sessionsNeedingReview: needsReview },
      },
      nextStep:
        'Pass a projectId to project_overview to expand a project, or find_sessions to page sessions.',
    };
  },
});
