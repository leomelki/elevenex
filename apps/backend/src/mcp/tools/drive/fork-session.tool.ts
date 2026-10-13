import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from './provider.util.js';
import { taskOperation } from '../setup/task.util.js';

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
    'Fork conversation history at an explicit user/assistant message into another session sharing the task checkout. Get anchor IDs with read_session(includeIds:true). User anchors return that prompt as an unsent draft; assistant anchors preserve history through the response. Does not start an agent. Use create_task for independent files.',
  currentSessionScope: 'session',
  inputShape: {
    anchorMessageId: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe('Provider message ID from read_session with includeIds:true.'),
    anchorMessageKind: z
      .enum(['user', 'assistant'])
      .describe(
        'Role of the anchor message. User anchors become an unsent draft.',
      ),
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
    const { session: forked, draft } = await taskOperation(() =>
      ctx.services.sessionForks.create(args.sessionId, {
        anchorMessageId: args.anchorMessageId,
        anchorMessageKind: args.anchorMessageKind,
        name: args.name,
      }),
    );
    return {
      data: {
        sessionId: forked.id,
        name: forked.name ?? `Session ${forked.id}`,
        status: forked.status,
        forkedFrom: args.sessionId,
        provider: forked.activeAgentProvider,
        anchorMessageId: args.anchorMessageId,
        anchorMessageKind: args.anchorMessageKind,
        draft: draft ?? null,
      },
      touched: { sessionId: forked.id },
      deepLink: ctx.deepLink.session(forked.id),
      nextStep: draft
        ? 'The anchor prompt is returned as an unsent draft, not executed. Inspect it before prompt_session.'
        : 'History preserved. prompt_session starts the fork; its files are shared with the source task.',
    };
  },
});
