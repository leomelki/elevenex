import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { actionMutationError, resolveAction } from './action.util.js';

/** Statuses that mean "there is nothing to stop" — reported, not raised. */
const NOT_RUNNING_PATTERN = /not running/i;

/**
 * stop_action — kill a running command (SIGTERM, then the tmux session). 🟡scoped,
 * mutates. Deliberately idempotent: stopping an already-finished action reports
 * its status instead of erroring, so a cleanup step never needs a guard read.
 */
export const stopActionTool = defineTool({
  name: 'stop_action',
  title: 'Stop action',
  costClass: 'scoped',
  mutates: true,
  description:
    'Stop a running Action (kills the command and its tmux session; the action itself is kept). 🟡scoped. Idempotent — if it already finished you get stopped:false plus its final status, not an error. Use before editing a running action, or to shut down a dev server you started. Get the actionId from list_actions.',
  annotations: { idempotentHint: true },
  inputShape: {
    actionId: z
      .number()
      .int()
      .positive()
      .describe('Action to stop, from list_actions.'),
  },
  handler: async (args, ctx) => {
    const action = await resolveAction(ctx, args.actionId);

    try {
      await ctx.services.actions.stop(args.actionId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!NOT_RUNNING_PATTERN.test(message)) {
        throw actionMutationError(error, {
          code: 'action_stop_failed',
          fallbackMessage: `Could not stop action "${action.name}".`,
          remediation:
            'Re-check its state with list_actions; the run may already be finishing.',
        });
      }

      const settled = await resolveAction(ctx, args.actionId);
      return {
        data: {
          actionId: settled.id,
          name: settled.name,
          stopped: false,
          status: settled.status,
          lastExitCode: settled.lastExitCode ?? undefined,
        },
        nextStep:
          'Action was not running. read_action_output to see how the last run ended.',
      };
    }

    const stopped = await resolveAction(ctx, args.actionId);
    return {
      data: {
        actionId: stopped.id,
        name: stopped.name,
        stopped: true,
        status: stopped.status,
        lastExitCode: stopped.lastExitCode ?? undefined,
      },
      touched: { actionId: stopped.id },
      nextStep:
        stopped.status === 'running'
          ? 'Stop requested; it settles a moment later — poll_action_status to confirm, then read_action_output.'
          : 'read_action_output for what it printed before being stopped.',
    };
  },
});
