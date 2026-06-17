import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from './provider.util.js';

/**
 * set_model — pick the model the session's agent runs (or reset to default).
 * Discover valid model ids from session_status' availableModels.
 */
export const setModelTool = defineTool({
  name: 'set_model',
  title: 'Set model',
  costClass: 'instant',
  mutates: true,
  description:
    "Set the model a session's agent uses, or null to reset to the provider default. ⚡instant. Get valid model ids from session_status (availableModels) first.",
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
      .describe('Model id (e.g. from session_status availableModels), or null to reset to default.'),
  },
  handler: async (args, ctx) => {
    const { provider } = await resolveSessionProvider(ctx, args.sessionId);
    const runtime = ctx.services.agentRuntime.getProvider(provider);
    const state = await runtime.setSelectedModel(args.sessionId, args.model);
    return {
      data: {
        sessionId: args.sessionId,
        model: (state as { selectedModel?: string | null }).selectedModel ?? args.model,
      },
      deepLink: ctx.deepLink.session(args.sessionId),
      nextStep: 'Trigger work with prompt_session.',
    };
  },
});
