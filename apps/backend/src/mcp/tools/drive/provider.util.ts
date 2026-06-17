import { ToolError } from '../../tool-registry/tool.types.js';
import type { ToolContext } from '../../tool-registry/tool.types.js';

/**
 * Resolve a session and its active agent provider id, mapping the domain
 * NotFoundException onto an actionable ToolError. Drive tools call this before
 * dispatching to the runtime registry so a bad id fails fast and self-corrects.
 */
export async function resolveSessionProvider(
  ctx: ToolContext,
  sessionId: number,
): Promise<{
  session: Awaited<ReturnType<ToolContext['services']['sessions']['findOne']>>;
  provider: string;
}> {
  const session = await ctx.services.sessions.findOne(sessionId).catch(() => null);
  if (!session) {
    throw new ToolError({
      code: 'session_not_found',
      message: `No session with id ${sessionId}.`,
      remediation: 'Get valid ids from find_sessions or project_overview.',
    });
  }
  return { session, provider: session.activeAgentProvider };
}
