import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from './provider.util.js';
import { taskOperation } from '../setup/task.util.js';

export const SESSION_LABEL_TOOLS = [
  defineTool({
    name: 'rename_session',
    title: 'Rename conversation',
    costClass: 'instant',
    mutates: true,
    currentSessionScope: 'session',
    annotations: { idempotentHint: true },
    description:
      'Rename a coding conversation without changing task identity, branch, history or agent execution. Defaults to the calling conversation; rename_task changes the task label.',
    inputShape: {
      sessionId: z
        .number()
        .int()
        .positive()
        .describe(
          'Conversation ID, from get_current_session/find_sessions/get_task.',
        ),
      name: z
        .string()
        .trim()
        .min(1)
        .max(160)
        .describe('Conversation display name, 1-160 characters.'),
    },
    handler: async (args, ctx) => {
      await resolveSessionProvider(ctx, args.sessionId);
      const session = await ctx.services.sessions.update(args.sessionId, {
        name: args.name,
      });
      return {
        data: { sessionId: session.id, name: session.name },
        touched: { sessionId: session.id },
        deepLink: ctx.deepLink.session(session.id),
      };
    },
  }),
  defineTool({
    name: 'unarchive_session',
    title: 'Restore conversation',
    costClass: 'scoped',
    mutates: true,
    description:
      'Restore one archived conversation without starting an agent. Requires its task to be active and ready and its folder restored; reopen_task restores a finished task and its conversations together.',
    inputShape: {
      sessionId: z
        .number()
        .int()
        .positive()
        .describe(
          'Archived conversation ID from find_sessions with state:archived/all or get_task.',
        ),
    },
    handler: async (args, ctx) => {
      await resolveSessionProvider(ctx, args.sessionId);
      const session = await taskOperation(() =>
        ctx.services.sessions.unarchive(args.sessionId),
      );
      return {
        data: {
          sessionId: session.id,
          name: session.name,
          status: session.status,
        },
        touched: { sessionId: session.id },
        deepLink: ctx.deepLink.session(session.id),
        nextStep:
          'read_session to inspect preserved history, or prompt_session to resume work.',
      };
    },
  }),
];
