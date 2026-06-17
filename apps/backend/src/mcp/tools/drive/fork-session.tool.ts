import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from './provider.util.js';

/**
 * fork_session — branch a session into an independent new session sharing the
 * same worktree. Use to try an alternative without disturbing the original.
 */
export const forkSessionTool = defineTool({
  name: 'fork_session',
  title: 'Fork session',
  costClass: 'scoped',
  mutates: true,
  description:
    'Fork a session into a new independent session in the same worktree, returning the new handle. 🟡scoped. Use to explore an alternative branch of work; then drive the fork with prompt_session.',
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Source session to fork from.'),
    name: z
      .string()
      .min(1)
      .optional()
      .describe('Optional name for the fork. Defaults to "<source> (fork)".'),
  },
  handler: async (args, ctx) => {
    // Validate source exists with an actionable error before forking.
    await resolveSessionProvider(ctx, args.sessionId);
    const forked = await ctx.services.sessions.fork(args.sessionId, args.name);
    return {
      data: {
        sessionId: forked.id,
        name: forked.name ?? `Session ${forked.id}`,
        status: forked.status,
        forkedFrom: args.sessionId,
        provider: forked.activeAgentProvider,
      },
      touched: { sessionId: forked.id },
      deepLink: ctx.deepLink.session(forked.id),
      nextStep: 'Drive the fork with prompt_session, or poll it with session_status.',
    };
  },
});
