import { defineTool, ToolError } from '../../tool-registry/tool.types.js';

export const getCurrentSessionTool = defineTool({
  name: 'get_current_session',
  title: 'Get current session',
  costClass: 'instant',
  requiresAgent: true,
  description:
    'Get the calling session’s live identity and working context: sessionId, projectId, repoId, taskId/workspaceId, worktreeId, folderId, worktreePath, branch, and provider. Instant DB reads, no transcript or git scan. Use to orient inside your own coding session; get_focused_session instead identifies the human’s UI focus for missions.',
  annotations: { readOnlyHint: true },
  inputShape: {},
  handler: async (_args, ctx) => {
    if (ctx.agentSessionId === null) {
      throw new ToolError({
        code: 'requires_agent_session',
        message: 'No authenticated calling session.',
        remediation: 'Connect using the session’s Elevenex bearer token.',
      });
    }
    const session = await ctx.services.sessions
      .findOne(ctx.agentSessionId)
      .catch(() => null);
    if (!session) {
      throw new ToolError({
        code: 'session_not_found',
        message: 'The calling session no longer exists.',
        remediation: 'Reconnect from an existing Elevenex session.',
      });
    }
    const [project, repo, task] = await Promise.all([
      ctx.services.projects.findOne(session.projectId),
      ctx.services.repos.findOne(session.repoId),
      session.workspaceId == null
        ? null
        : ctx.services.tasks.record(session.workspaceId).catch(() => null),
    ]);
    return {
      data: {
        sessionId: session.id,
        name: session.name,
        surface: session.surface,
        status: session.status,
        provider: session.activeAgentProvider,
        projectId: session.projectId,
        projectName: project.name,
        repoId: session.repoId,
        repoName: repo.name,
        repoPath: repo.path,
        workspaceId: session.workspaceId,
        workspaceName: session.workspaceName,
        taskId: task?.id ?? null,
        taskName: task?.name ?? null,
        taskState: task?.taskState ?? null,
        taskFinishedAt: task?.archivedAt ?? null,
        worktreeId: task?.poolWorktreeId ?? null,
        checkoutMode: task?.checkoutMode ?? null,
        linkStatus: task?.linkStatus ?? null,
        folderId: session.folderId,
        worktreePath: session.worktreePath,
        branchName: session.branchName,
        isTemporary: session.isTemporary,
        planMode: session.planMode,
      },
      deepLink: ctx.deepLink.session(session.id),
      nextStep:
        'Continue this task with native coding tools. get_task inspects its lifecycle and related conversations; list_tasks finds separate work. Task IDs persist when worktrees are released or reassigned.',
    };
  },
});
