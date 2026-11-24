import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from './provider.util.js';
import { sessionAgentReference } from '../../../sessions/session-agent-message.js';

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
    "Interrupt a session's currently running agent turn (the session stays alive). 🟡scoped. Use when a prompt_session run is off-track; then inspect session_status. Interruption pauses queued prompts; resume_pending_prompts explicitly resumes that queue.",
  disallowSelfTarget: 'session',
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session whose running turn to interrupt.'),
  },
  handler: async (args, ctx) => {
    const { provider, session } = await resolveSessionProvider(ctx, args.sessionId);
    const runtime = ctx.services.agentRuntime.getProvider(provider);
    await runtime.interrupt(args.sessionId);
    if (ctx.agentSessionId !== null && session.delegatedBySessionId === ctx.agentSessionId)
      ctx.services.sessions.delegationHandoffs?.collected(args.sessionId, ctx.agentSessionId);
    ctx.services.sessions.emit?.('session-turn-interrupted', { sessionId: args.sessionId });
    return {
      data: { sessionId: args.sessionId, interrupted: true, session: sessionAgentReference(session) },
      deepLink: ctx.deepLink.session(args.sessionId),
      nextStep:
        'Inspect session_status. Use resume_pending_prompts to explicitly continue a paused queue; prompt_session only adds more queued work while it is paused.',
    };
  },
});
