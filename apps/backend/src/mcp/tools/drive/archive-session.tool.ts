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
    'Stop and archive one conversation while leaving its task and worktree assigned. unarchive_session restores it; finish_task finishes the entire task and may release its clean checkout. Cannot archive the calling session.',
  disallowSelfTarget: 'session',
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
