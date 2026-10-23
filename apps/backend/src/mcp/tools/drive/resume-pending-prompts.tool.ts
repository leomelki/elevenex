import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from './provider.util.js';

export const resumePendingPromptsTool = defineTool({
  name: 'resume_pending_prompts',
  title: 'Resume pending prompts',
  costClass: 'scoped',
  mutates: true,
  disallowSelfTarget: 'session',
  description:
    'Explicitly resume another session’s paused prompt queue after an interruption. 🟡scoped. Resumes existing queued work through its active provider; inspect session_status first, then poll_session_status or await_session_event for progress. Sending a new prompt does not resume a paused queue.',
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session whose queued prompts to resume.'),
  },
  handler: async (args, ctx) => {
    const { session, provider } = await resolveSessionProvider(
      ctx,
      args.sessionId,
    );
    if (session.status === 'archived') {
      throw new ToolError({
        code: 'session_archived',
        message: 'Archived sessions are read-only.',
        remediation: 'Use unarchive_session before resuming its queue.',
      });
    }
    await ctx.services.sessions.assertSessionWorkspaceLinked(args.sessionId);
    ctx.signal.throwIfAborted();
    await ctx.services.agentRuntime
      .getProvider(provider)
      .resumePendingPrompts(args.sessionId);
    return {
      data: { sessionId: args.sessionId, resumed: true, provider },
      deepLink: ctx.deepLink.session(args.sessionId),
      nextStep:
        'Queue resume requested. Inspect session_status, or poll_session_status / await_session_event for progress.',
    };
  },
});
