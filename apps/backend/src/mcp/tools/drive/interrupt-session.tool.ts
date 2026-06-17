import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from './provider.util.js';

/**
 * interrupt_session — stop the agent's in-flight turn without killing the
 * session. Use when a running prompt is going the wrong way.
 */
export const interruptSessionTool = defineTool({
  name: 'interrupt_session',
  title: 'Interrupt session',
  costClass: 'scoped',
  mutates: true,
  description:
    "Interrupt a session's currently running agent turn (the session stays alive). 🟡scoped. Use when a prompt_session run is off-track; then re-prompt with prompt_session or inspect with session_status.",
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session whose running turn to interrupt.'),
  },
  handler: async (args, ctx) => {
    const { provider } = await resolveSessionProvider(ctx, args.sessionId);
    const runtime = ctx.services.agentRuntime.getProvider(provider);
    await runtime.interrupt(args.sessionId);
    return {
      data: { sessionId: args.sessionId, interrupted: true },
      deepLink: ctx.deepLink.session(args.sessionId),
      nextStep: 'Re-prompt with prompt_session, or inspect with session_status.',
    };
  },
});
