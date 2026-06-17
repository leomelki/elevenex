import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from './provider.util.js';

/**
 * resolve_action — answer a session's pending permission request, unblocking a
 * waiting agent turn. Get the requestId from get_pending_action first.
 */
export const resolveActionTool = defineTool({
  name: 'resolve_action',
  title: 'Resolve action',
  costClass: 'scoped',
  mutates: true,
  description:
    'Approve or deny a pending permission request to unblock a waiting session. 🟡scoped. Get the requestId from get_pending_action first; then resume polling with session_status.',
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session whose pending permission to resolve.'),
    requestId: z
      .string()
      .min(1)
      .describe('The pending permission requestId from get_pending_action.'),
    decision: z
      .enum(['approve', 'deny'])
      .describe("'approve' to allow the action, 'deny' to block it."),
    remember: z
      .boolean()
      .default(false)
      .describe(
        'On approve: persist this allowance for the rest of the session. Ignored on deny. Default false.',
      ),
    message: z
      .string()
      .optional()
      .describe('Optional reason shown to the agent when denying.'),
  },
  handler: async (args, ctx) => {
    const { provider } = await resolveSessionProvider(ctx, args.sessionId);

    if (args.decision === 'approve') {
      const runtime = ctx.services.agentRuntime.getProviderFeature(
        provider,
        'approvePermission',
      );
      await runtime.approvePermission(
        args.sessionId,
        args.requestId,
        args.remember,
      );
    } else {
      const runtime = ctx.services.agentRuntime.getProviderFeature(
        provider,
        'denyPermission',
      );
      await runtime.denyPermission(args.sessionId, args.requestId, args.message);
    }

    return {
      data: { sessionId: args.sessionId, resolved: true, decision: args.decision },
      deepLink: ctx.deepLink.session(args.sessionId),
      nextStep: 'Resume polling with session_status / await_session_event.',
    };
  },
});
