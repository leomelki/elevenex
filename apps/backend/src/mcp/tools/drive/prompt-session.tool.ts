import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from './provider.util.js';

/**
 * prompt_session — trigger or continue a session's agent with a prompt. Ensures
 * the session is started, then submits and returns IMMEDIATELY (never blocks on
 * the agent's reply).
 */
export const promptSessionTool = defineTool({
  name: 'prompt_session',
  title: 'Prompt session',
  costClass: 'heavy',
  mutates: true,
  description:
    "Send a prompt to a session's agent to start or continue work; returns at once with an accepted handle (does NOT wait for the reply). 🔴heavy. Then poll session_status / await_session_event, and resolve any prompt with get_pending_action → resolve_action.",
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session to prompt. Get ids from find_sessions / project_overview.'),
    prompt: z
      .string()
      .min(1)
      .describe('The instruction to send to the agent. Required, non-empty.'),
  },
  handler: async (args, ctx) => {
    const { session, provider } = await resolveSessionProvider(ctx, args.sessionId);

    // Idempotent start: archived sessions throw inside start(); active ones are
    // a cheap no-op. We start unless already in a live run state.
    if (session.status !== 'active' && session.status !== 'running') {
      await ctx.services.sessions.start(args.sessionId);
    }

    const runtime = ctx.services.agentRuntime.getProvider(provider);
    await runtime.submitPrompt(args.sessionId, args.prompt);

    return {
      data: { sessionId: args.sessionId, accepted: true, provider },
      deepLink: ctx.deepLink.session(args.sessionId),
      nextStep:
        'Poll session_status / await_session_event; resolve permission prompts with get_pending_action → resolve_action.',
    };
  },
});
