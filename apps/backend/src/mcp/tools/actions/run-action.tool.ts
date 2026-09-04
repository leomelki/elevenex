import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import {
  actionHandle,
  actionMutationError,
  resolveAction,
  type ActionRow,
} from './action.util.js';

/**
 * run_action — start a saved command. 🔴heavy, mutates.
 *
 * Returns as soon as the process is spawned (the run itself keeps going in a
 * tmux-backed pty and survives a backend restart), so the agent never sits
 * blocking here: wait with poll_action_status instead.
 */
export const runActionTool = defineTool({
  name: 'run_action',
  title: 'Run action',
  costClass: 'heavy',
  mutates: true,
  description:
    "Start one of a worktree's saved Actions (its shell command — build, test, lint, dev server). 🔴heavy: launches a real process and returns immediately with status 'running', it does NOT wait for the command to finish. Wait with poll_action_status (blocks up to 170 s), or tail it with read_action_output. Get the actionId from list_actions. The command runs in the worktree, so run it only when you actually want its side effects.",
  inputShape: {
    actionId: z
      .number()
      .int()
      .positive()
      .describe('Action to start, from list_actions.'),
  },
  handler: async (args, ctx) => {
    const action = await resolveAction(ctx, args.actionId);

    const started = (await ctx.services.actions
      .run(args.actionId)
      .catch((error: unknown) => {
        throw actionMutationError(error, {
          code: 'action_run_failed',
          fallbackMessage: `Could not start action "${action.name}".`,
          remediation:
            'If it is already running, wait with poll_action_status or stop_action first; otherwise check the command with list_actions.',
        });
      })) as ActionRow;

    return {
      data: {
        ...actionHandle(started),
        worktreePath: started.worktreePath,
        startedAt: started.lastRunAt ?? undefined,
      },
      touched: { actionId: started.id },
      nextStep:
        'poll_action_status to wait for it to finish (up to 170 s per call), or read_action_output for a live tail. Do not sleep in a loop.',
    };
  },
});
