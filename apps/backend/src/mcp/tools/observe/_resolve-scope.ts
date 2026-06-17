import { ToolError } from '../../tool-registry/tool.types.js';
import type { ToolContext } from '../../tool-registry/tool.types.js';

/**
 * Resolves the worktree scope for file/diff observe tools. Either a `sessionId`
 * (resolved to its worktreePath + repoId) or an explicit `worktreePath` must be
 * given; throws a self-correcting ToolError otherwise.
 */
export async function resolveWorktreeScope(
  ctx: ToolContext,
  args: { sessionId?: number; worktreePath?: string; repoId?: number },
): Promise<{ worktreePath: string; repoId: number | null; sessionId: number | null }> {
  if (args.sessionId !== undefined) {
    const session = await ctx.services.sessions
      .findOne(args.sessionId)
      .catch(() => null);
    if (!session) {
      throw new ToolError({
        code: 'session_not_found',
        message: `No session with id ${args.sessionId}.`,
        remediation: 'List valid ids with find_sessions or project_overview.',
      });
    }
    return {
      worktreePath: session.worktreePath,
      repoId: session.repoId,
      sessionId: session.id,
    };
  }

  if (args.worktreePath) {
    return {
      worktreePath: args.worktreePath,
      repoId: args.repoId ?? null,
      sessionId: null,
    };
  }

  throw new ToolError({
    code: 'scope_required',
    message: 'A sessionId (preferred) or worktreePath is required to bound this tool.',
    remediation: 'Pass sessionId from find_sessions, or an explicit worktreePath.',
  });
}
