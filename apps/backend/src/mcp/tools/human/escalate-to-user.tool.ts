import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveDeepLink } from './deep-link-arg.js';

/**
 * escalate_to_user — BLOCK on an open-ended blocker: tell the human what you're
 * stuck on and wait for their guidance/choice. 🔴heavy. Distinct from
 * request_approval (yes/no on a specific action): use this when you need a
 * direction, not a permission.
 */
export const escalateToUserTool = defineTool({
  name: 'escalate_to_user',
  title: 'Escalate to user',
  costClass: 'heavy',
  requiresAgent: true,
  description:
    "Hand a blocker to the human and BLOCK until they choose how to proceed. 🔴heavy. Use when you're genuinely stuck and need direction (ambiguous requirement, missing info, conflicting options) — not for a simple action approval (use request_approval). Returns { choice }.",
  inputShape: {
    blockedOn: z
      .string()
      .min(1)
      .describe('What is blocking you, in one line (becomes the escalation title).'),
    detail: z
      .string()
      .optional()
      .describe('Context: what you tried, what you need, the trade-offs.'),
    options: z
      .array(z.string().min(1))
      .min(2)
      .optional()
      .describe("Directions to offer the human. Default ['proceed','stop']."),
    sessionId: z.number().int().positive().optional().describe('Optional: Open→session deep link.'),
    projectId: z.number().int().positive().optional().describe('Optional: Open→project deep link.'),
    deepLink: z.string().optional().describe('Optional explicit deep link; overrides sessionId/projectId.'),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(60 * 60 * 1000)
      .default(30 * 60 * 1000)
      .describe('Max wait before resolving as the first option (denied) (1s–60m). Default 30m.'),
  },
  handler: async (args, ctx) => {
    const deepLink = resolveDeepLink(ctx, args);
    const resolution = await ctx.human.requestApproval({
      title: args.blockedOn,
      detail: args.detail,
      options: args.options ?? ['proceed', 'stop'],
      deepLink,
      timeoutMs: args.timeoutMs,
    });
    return {
      data: { choice: resolution.decision, note: resolution.note },
      deepLink,
      nextStep: `Human chose "${resolution.decision}" — act on it.`,
    };
  },
});
