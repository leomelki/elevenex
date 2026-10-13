import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from './provider.util.js';

/**
 * set_permission_mode — control how aggressively the session's agent asks for
 * permission. 'bypassPermissions' lets it act without prompts; 'plan' keeps it
 * read-only/planning; null resets to the provider default.
 */
export const setPermissionModeTool = defineTool({
  name: 'set_permission_mode',
  title: 'Set permission mode',
  costClass: 'instant',
  mutates: true,
  description:
    'Set a conversation’s permission mode, or null to restore its provider default. Use get_session_config to discover supported modes. Does not start an agent.',
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session whose permission mode to set.'),
    mode: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .nullable()
      .describe(
        'Provider permission mode from get_session_config.permissionModes, or null to restore its default. Runtime validation is authoritative.',
      ),
  },
  handler: async (args, ctx) => {
    const { provider } = await resolveSessionProvider(ctx, args.sessionId);
    const runtime = ctx.services.agentRuntime.getProviderFeature(
      provider,
      'setPermissionMode',
    );
    await runtime.setPermissionMode(args.sessionId, args.mode);
    return {
      data: { sessionId: args.sessionId, mode: args.mode },
      deepLink: ctx.deepLink.session(args.sessionId),
      nextStep: 'Trigger or continue work with prompt_session.',
    };
  },
});
