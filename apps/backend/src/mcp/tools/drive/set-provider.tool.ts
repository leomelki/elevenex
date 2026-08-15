import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';

/**
 * set_provider â€” choose which agent backend (claude/codex/pi/gemini) a session uses.
 * Only meaningful before the session has started; switching after start is a
 * no-op for the running runtime.
 */
export const setProviderTool = defineTool({
  name: 'set_provider',
  title: 'Set provider',
  costClass: 'instant',
  mutates: true,
  description:
    "Set which agent backend a session uses (claude/codex/pi/gemini). âš¡instant. Only applies before the session starts â€” set it before the first prompt_session.",
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session to reconfigure.'),
    provider: z
      .enum(['claude', 'codex', 'pi', 'gemini'])
      .describe('Agent backend to use. Applies only before the session starts.'),
  },
  handler: async (args, ctx) => {
    const updated = await ctx.services.sessions
      .updateActiveAgentProvider(args.sessionId, args.provider)
      .catch((err: unknown) => {
        throw new ToolError({
          code: 'set_provider_failed',
          message:
            err instanceof Error ? err.message : `Could not set provider on session ${args.sessionId}.`,
          remediation:
            'Confirm the sessionId via find_sessions and that the session has not started yet.',
        });
      });
    return {
      data: {
        sessionId: args.sessionId,
        provider: updated.activeAgentProvider,
      },
      deepLink: ctx.deepLink.session(args.sessionId),
      nextStep: 'Trigger work with prompt_session.',
    };
  },
});
