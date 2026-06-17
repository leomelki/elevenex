import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from './provider.util.js';

/**
 * archive_session — stop and archive a session. Reversible bookkeeping (the
 * session is retired, not deleted). Use when work is done or abandoned.
 */
export const archiveSessionTool = defineTool({
  name: 'archive_session',
  title: 'Archive session',
  costClass: 'scoped',
  mutates: true,
  description:
    'Stop and archive a session once its work is finished or abandoned (retires it, not destructive). 🟡scoped. Distinct from reset_session, which wipes and starts fresh in the same worktree.',
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session to stop and archive.'),
  },
  handler: async (args, ctx) => {
    await resolveSessionProvider(ctx, args.sessionId);
    await ctx.services.sessions.archiveAndStop(args.sessionId);
    return {
      data: { sessionId: args.sessionId, archived: true },
      nextStep: 'List remaining sessions with find_sessions.',
    };
  },
});
