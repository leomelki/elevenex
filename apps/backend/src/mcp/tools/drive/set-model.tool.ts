import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from './provider.util.js';

/**
 * set_model — pick the model the session's agent runs (or reset to default).
 * Discover valid model ids from get_session_config.
 */
export const setModelTool = defineTool({
  name: 'set_model',
  title: 'Set model',
  costClass: 'instant',
  mutates: true,
  description:
    "Set the model a session's agent uses, or null to restore its provider default. Get valid model IDs from get_session_config first. Does not start an agent.",
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session whose model to set.'),
    model: z
      .string()
      .min(1)
      .nullable()
      .describe(
        'Model ID from get_session_config, or null to restore the default.',
      ),
  },
  handler: async (args, ctx) => {
    const { provider } = await resolveSessionProvider(ctx, args.sessionId);
    const runtime = ctx.services.agentRuntime.getProvider(provider);
    const state = await runtime.setSelectedModel(args.sessionId, args.model);
    return {
      data: {
        sessionId: args.sessionId,
        model:
          (state as { selectedModel?: string | null }).selectedModel ??
          args.model,
      },
      deepLink: ctx.deepLink.session(args.sessionId),
      nextStep: 'Trigger work with prompt_session.',
    };
  },
});
