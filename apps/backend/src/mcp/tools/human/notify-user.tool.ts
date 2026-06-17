import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveDeepLink } from './deep-link-arg.js';

/**
 * notify_user — fire-and-forget FYI to the human (toast + panel item). Does NOT
 * block. ⚡instant. Use for progress/status the human may want but needn't act
 * on; use request_approval when you need a decision before continuing.
 */
export const notifyUserTool = defineTool({
  name: 'notify_user',
  title: 'Notify user',
  costClass: 'instant',
  requiresAgent: true,
  description:
    'Send the human a non-blocking notification (toast + panel entry) — progress, a result, or an FYI. ⚡instant, returns immediately. For a decision you must wait on, use request_approval / escalate_to_user instead.',
  inputShape: {
    message: z.string().min(1).describe('The notification text. Keep it one line.'),
    level: z
      .enum(['info', 'success', 'warning', 'error'])
      .default('info')
      .describe("Severity tint. Default 'info'."),
    sessionId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Optional: builds an Open→session deep link for the human.'),
    projectId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Optional: builds an Open→project deep link (used if sessionId is absent).'),
    deepLink: z
      .string()
      .optional()
      .describe('Optional explicit deep link (e.g. one returned by another tool). Overrides sessionId/projectId.'),
  },
  handler: async (args, ctx) => {
    const deepLink = resolveDeepLink(ctx, args);
    const { id } = await ctx.human.notify({
      level: args.level,
      message: args.message,
      deepLink,
    });
    return {
      data: { notified: true, id },
      deepLink,
      nextStep: 'Continue; the human is informed but not blocking you.',
    };
  },
});
