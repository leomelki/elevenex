import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from './provider.util.js';
import type {
  ClaudePermissionRequest,
  ClaudeUserInputRequest,
} from '../../../claude-runtime/claude-runtime.types.js';

/**
 * The fields of the concrete runtime state we read. The base
 * AgentRuntimeStatePayload is intentionally minimal; the live claude runtime
 * returns the richer ClaudeRuntimeStatePayload, so we narrow defensively.
 */
type PendingState = {
  sessionState?: string | null;
  pendingPermissionRequest?: ClaudePermissionRequest | null;
  pendingUserInputRequest?: ClaudeUserInputRequest | null;
};

/**
 * get_pending_action — peek at whether a session is blocked waiting on a human
 * decision (permission prompt or user-input request). ⚡instant. Pairs with
 * resolve_action to unblock it.
 */
export const getPendingActionTool = defineTool({
  name: 'get_pending_action',
  title: 'Get pending action',
  costClass: 'instant',
  annotations: { readOnlyHint: true },
  description:
    'Check if a session is blocked on a pending permission or user-input request and return it compacted (requestId, tool, summary), else null. ⚡instant. Unblock it with resolve_action.',
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session to inspect for a pending permission/input request.'),
  },
  handler: async (args, ctx) => {
    const { provider } = await resolveSessionProvider(ctx, args.sessionId);
    const runtime = ctx.services.agentRuntime.getProvider(provider);
    const state = (await runtime.getRuntimeState(args.sessionId)) as PendingState;

    const sessionState = state.sessionState ?? null;
    const perm = state.pendingPermissionRequest ?? null;
    const input = state.pendingUserInputRequest ?? null;

    if (perm) {
      return {
        data: {
          pending: {
            kind: 'permission' as const,
            requestId: perm.requestId,
            toolName: perm.toolName,
            title: perm.title ?? perm.toolDisplayName ?? perm.toolName,
            description: perm.description ?? perm.decisionReason ?? null,
          },
          state: sessionState,
        },
        deepLink: ctx.deepLink.session(args.sessionId),
        nextStep: "resolve_action with decision 'approve' or 'deny'.",
      };
    }

    if (input) {
      return {
        data: {
          pending: {
            kind: 'user_input' as const,
            requestId: input.requestId,
            toolName: input.serverName,
            title: input.title ?? input.displayName ?? input.serverName,
            description: input.description ?? input.message ?? null,
          },
          state: sessionState,
        },
        deepLink: ctx.deepLink.session(args.sessionId),
        nextStep:
          'A user-input request is pending; surface it to the human (resolve_action handles permission prompts).',
      };
    }

    return {
      data: { pending: null, state: sessionState },
      nextStep:
        'Nothing blocking. Poll session_status / await_session_event, or prompt_session.',
    };
  },
});
