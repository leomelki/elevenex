import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveDeepLink } from './deep-link-arg.js';

/**
 * show_user — push a richer "look at this" card to the panel (title + body +
 * optional Open). Does NOT block. ⚡instant. Heavier than notify_user (a card,
 * not a toast); still informational — use request_approval to wait on a choice.
 */
export const showUserTool = defineTool({
  name: 'show_user',
  title: 'Show user',
  costClass: 'instant',
  requiresAgent: true,
  description:
    'Surface a richer panel card for the human to review (title + body + optional Open link) — e.g. a summary, a diff pointer, a PR. ⚡instant, non-blocking. Use request_approval when you must wait for a decision.',
  inputShape: {
    title: z.string().min(1).describe('Short card title.'),
    body: z
      .string()
      .optional()
      .describe('Optional detail/markdown body. Keep it scannable.'),
    sessionId: z.number().int().positive().optional().describe('Optional: Open→session deep link.'),
    projectId: z.number().int().positive().optional().describe('Optional: Open→project deep link.'),
    deepLink: z.string().optional().describe('Optional explicit deep link; overrides sessionId/projectId.'),
  },
  handler: async (args, ctx) => {
    const deepLink = resolveDeepLink(ctx, args);
    const { id } = await ctx.human.show({
      title: args.title,
      body: args.body,
      deepLink,
    });
    return {
      data: { shown: true, id },
      deepLink,
      nextStep: 'Continue; this is informational, not a gate.',
    };
  },
});
