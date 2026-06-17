import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveDeepLink } from './deep-link-arg.js';

/**
 * request_approval — BLOCK until the human approves/denies a specific action.
 * 🔴heavy (waits for a person). Use before risky/irreversible ops in Review
 * mode (push, open/approve PR, steal a worktree, reset). Returns the decision.
 */
export const requestApprovalTool = defineTool({
  name: 'request_approval',
  title: 'Request approval',
  costClass: 'heavy',
  requiresAgent: true,
  description:
    'Ask the human to approve/deny a specific action and BLOCK until they answer (or it times out → denied). 🔴heavy. Use before risky ops (push, PR open/approve, steal_worktree, reset_session). Returns { decision }. For an open-ended blocker, use escalate_to_user.',
  inputShape: {
    title: z.string().min(1).describe('What you want to do, in one line (e.g. "Push branch feat/auth").'),
    detail: z.string().optional().describe('Optional context to help the human decide.'),
    options: z
      .array(z.string().min(1))
      .min(2)
      .optional()
      .describe("Choices to offer. Default ['approve','deny']."),
    sessionId: z.number().int().positive().optional().describe('Optional: Open→session deep link.'),
    projectId: z.number().int().positive().optional().describe('Optional: Open→project deep link.'),
    deepLink: z.string().optional().describe('Optional explicit deep link; overrides sessionId/projectId.'),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(30 * 60 * 1000)
      .default(10 * 60 * 1000)
      .describe('Max wait before resolving as denied (1s–30m). Default 10m.'),
  },
  handler: async (args, ctx) => {
    const deepLink = resolveDeepLink(ctx, args);
    const resolution = await ctx.human.requestApproval({
      title: args.title,
      detail: args.detail,
      options: args.options,
      deepLink,
      timeoutMs: args.timeoutMs,
    });
    const approved =
      resolution.decision === 'approve' || resolution.decision === (args.options?.[0] ?? '');
    return {
      data: {
        decision: resolution.decision,
        approved,
        note: resolution.note,
      },
      deepLink,
      nextStep: approved
        ? 'Approved — proceed with the action.'
        : 'Not approved — do not perform the action; pick an alternative or notify_user.',
    };
  },
});
