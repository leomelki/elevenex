import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { actionMutationError, resolveAction } from './action.util.js';

/**
 * delete_action — remove a saved command from the worktree's panel. ⚡instant,
 * mutates. Not flagged destructive: it deletes only the elevenex record (name +
 * command), touches no files, and the command it held is returned so it can be
 * recreated verbatim. Editing is still the better move — see set_action.
 */
export const deleteActionTool = defineTool({
  name: 'delete_action',
  title: 'Delete action',
  costClass: 'instant',
  mutates: true,
  description:
    "Remove a saved Action from a worktree's Actions panel. ⚡instant. Deletes only the elevenex record (its name + command) — no files are touched and nothing running is affected, since a running action must be stopped first (stop_action). Prefer set_action to fix a wrong command; delete only actions that are genuinely obsolete, and don't delete the human's actions without asking. actionId comes from list_actions.",
  inputShape: {
    actionId: z
      .number()
      .int()
      .positive()
      .describe('Action to delete, from list_actions.'),
  },
  handler: async (args, ctx) => {
    const action = await resolveAction(ctx, args.actionId);

    await ctx.services.actions.remove(args.actionId).catch((error: unknown) => {
      throw actionMutationError(error, {
        code: 'action_delete_failed',
        fallbackMessage: `Could not delete action "${action.name}".`,
        remediation:
          'A running action cannot be deleted — stop_action first, then retry.',
      });
    });

    return {
      data: {
        actionId: action.id,
        name: action.name,
        // Echoed so the deletion is trivially reversible with set_action.
        command: action.command,
        worktreePath: action.worktreePath,
        deleted: true,
      },
      touched: { actionId: action.id },
      nextStep:
        'list_actions to confirm the panel, or set_action with the echoed command to restore it.',
    };
  },
});
