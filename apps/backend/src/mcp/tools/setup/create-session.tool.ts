import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';

/**
 * create_session â€” create an inner coding session in a worktree, ready to be
 * triggered with prompt_session. âš¡instant, mutating. This is the bridge between
 * provisioning (link_worktree / create_worktree) and driving (prompt_session):
 * you cannot prompt work into existence without a session.
 *
 * Accepts a workspaceId (the natural output of link_worktree) OR an explicit
 * worktreePath + branchName (e.g. from a finished create_worktree job). The
 * session is NOT started here â€” prompt_session starts it on the first prompt.
 */
export const createSessionTool = defineTool({
  name: 'create_session',
  title: 'Create session',
  costClass: 'instant',
  mutates: true,
  description:
    'Create an inner coding session in a worktree (does not start it). âš¡instant. Pass a workspaceId from link_worktree, or a worktreePath+branchName from a finished create_worktree job. Next: prompt_session to trigger work, then await_session_event to watch it.',
  inputShape: {
    repoId: z
      .number()
      .int()
      .positive()
      .describe('Repo the session belongs to. From project_overview / add_repo.'),
    workspaceId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Linked workspace to run in (preferred â€” returned by link_worktree). If set, branch/path are taken from it.'),
    worktreePath: z
      .string()
      .min(1)
      .optional()
      .describe('Absolute worktree path to run in (use when you have no workspaceId, e.g. from a create_worktree job result). Requires branchName.'),
    branchName: z
      .string()
      .min(1)
      .optional()
      .describe('Branch the worktree is on. Required when using worktreePath instead of workspaceId.'),
    name: z
      .string()
      .min(1)
      .optional()
      .describe('Optional session name; auto-generated (e.g. "Session 3") if omitted.'),
    provider: z
      .enum(['claude', 'codex', 'pi', 'gemini'])
      .default('claude')
      .describe("Inner agent provider for this session. Default 'claude'."),
  },
  handler: async (args, ctx) => {
    const { repos, sessions } = ctx.services;

    // Validate the repo up front so the agent gets a clean error instead of an
    // opaque FK failure.
    const repo = await repos.findOne(args.repoId).catch(() => null);
    if (!repo) {
      throw new ToolError({
        code: 'repo_not_found',
        message: `No repo with id ${args.repoId}.`,
        remediation: 'Get a valid repoId from project_overview or add_repo.',
      });
    }

    if (
      args.workspaceId === undefined &&
      !(args.worktreePath && args.branchName)
    ) {
      throw new ToolError({
        code: 'scope_required',
        message:
          'create_session needs a workspaceId, or both worktreePath and branchName.',
        remediation:
          'Pass the workspaceId from link_worktree, or the worktreePath (from a finished create_worktree job) together with its branchName.',
      });
    }

    let session;
    try {
      session = await sessions.create({
        repoId: args.repoId,
        workspaceId: args.workspaceId,
        worktreePath: args.worktreePath,
        branchName: args.branchName,
        name: args.name,
        surface: 'session',
        activeAgentProvider: args.provider,
      });
    } catch (error) {
      throw new ToolError({
        code: 'create_session_failed',
        message: error instanceof Error ? error.message : 'Could not create session.',
        remediation:
          'Ensure the worktree exists on disk (create_worktree/link_worktree first) and the workspace/branch are valid.',
        retryable: false,
      });
    }

    return {
      data: {
        sessionId: session.id,
        name: session.name ?? `Session ${session.id}`,
        repoId: session.repoId,
        branch: session.branchName,
        worktreePath: session.worktreePath,
        provider: session.activeAgentProvider,
        status: session.status,
      },
      touched: { sessionId: session.id },
      deepLink: ctx.deepLink.session(session.id),
      nextStep:
        'Trigger work with prompt_session, then await_session_event / session_status to watch it.',
    };
  },
});
