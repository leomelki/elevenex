import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from './provider.util.js';

/**
 * reset_session — archive the current session and recreate a fresh one in the
 * same worktree. Destructive: the existing conversation is retired and a new
 * session id replaces it.
 */
export const resetSessionTool = defineTool({
  name: 'reset_session',
  title: 'Reset session',
  costClass: 'scoped',
  mutates: true,
  destructive: true,
  description:
    'Wipe a session by archiving it and spawning a fresh session in the same worktree, returning the new id. 🟡scoped, DESTRUCTIVE (the old conversation is retired). Use to start over cleanly; prompt_session the new id afterward.',
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session to reset (archived, then replaced by a fresh one).'),
  },
  handler: async (args, ctx) => {
    await resolveSessionProvider(ctx, args.sessionId);
    const fresh = await ctx.services.sessions.reset(args.sessionId);
    return {
      data: {
        sessionId: args.sessionId,
        reset: true,
        newSessionId: fresh.id,
        provider: fresh.activeAgentProvider,
      },
      touched: { sessionId: fresh.id },
      deepLink: ctx.deepLink.session(fresh.id),
      nextStep: 'Drive the fresh session (newSessionId) with prompt_session.',
    };
  },
});
