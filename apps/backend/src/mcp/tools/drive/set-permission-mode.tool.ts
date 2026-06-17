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
    "Set a session's permission mode to govern how the agent asks before acting (default/acceptEdits/plan/bypassPermissions), or null to reset. ⚡instant. Use 'bypassPermissions' for hands-off autonomy; pair with get_pending_action when prompts are expected.",
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session whose permission mode to set.'),
    mode: z
      .enum(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
      .nullable()
      .describe(
        "Permission mode: 'default' (ask), 'acceptEdits' (auto-approve edits), 'plan' (read-only planning), 'bypassPermissions' (no prompts), or null to reset to provider default.",
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
