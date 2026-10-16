import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from './provider.util.js';

/**
 * stop_background_task — end one background task in another session without
 * interrupting its turn. Waits treat live background work as unfinished, so a
 * shell left behind by a finished subagent otherwise holds them until Claude
 * Code's background time limit.
 */
export const stopBackgroundTaskTool = defineTool({
  name: 'stop_background_task',
  title: 'Stop background task',
  costClass: 'scoped',
  mutates: true,
  description:
    "Stop one background task (a backgrounded shell or subagent) in a session, leaving the session and its turn alive. 🟡scoped. Use on items from session_status/poll_session_status `backgroundWork`, especially `orphaned` ones left behind by a finished subagent. The session may resume briefly to report the stop; then await_session_event.",
  disallowSelfTarget: 'session',
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session that owns the background task.'),
    taskId: z
      .string()
      .min(1)
      .max(200)
      .describe('`taskId` from a `backgroundWork` item.'),
  },
  handler: async (args, ctx) => {
    const { provider } = await resolveSessionProvider(ctx, args.sessionId);
    await ctx.services.agentRuntime
      .getProviderFeature(provider, 'stopBackgroundTask')
      .stopBackgroundTask(args.sessionId, args.taskId);
    return {
      data: { sessionId: args.sessionId, taskId: args.taskId, stopped: true },
      deepLink: ctx.deepLink.session(args.sessionId),
      nextStep:
        'await_session_event or poll_session_status to wait for the session to settle.',
    };
  },
});
