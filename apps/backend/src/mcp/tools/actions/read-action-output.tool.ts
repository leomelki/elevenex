import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import {
  currentOutputOf,
  resolveAction,
  runDurationSeconds,
  tailOutput,
} from './action.util.js';

/** Hard cap so one read can never blow the token budget. */
const MAX_TAIL_LINES = 400;
const DEFAULT_TAIL_LINES = 80;

/**
 * read_action_output — the tail of an action's output. ⚡instant.
 * Live buffer while the command runs (flushed every ~250 ms), the last run's
 * output once it has settled. ANSI escapes and `\r`-overwritten progress lines
 * are stripped before the tail is taken.
 */
export const readActionOutputTool = defineTool({
  name: 'read_action_output',
  title: 'Read action output',
  costClass: 'instant',
  description:
    "Tail of what an Action printed — the live buffer while it runs, otherwise its last run's output (ANSI stripped, progress bars collapsed). ⚡instant, defaults to the last 80 lines and hard-capped at 400 — the tail is where the failure is. Use after poll_action_status reports 'failed', or to check on a long build. Get the actionId from list_actions.",
  annotations: { readOnlyHint: true },
  inputShape: {
    actionId: z
      .number()
      .int()
      .positive()
      .describe('Action whose output to read, from list_actions.'),
    tailLines: z
      .number()
      .int()
      .min(1)
      .max(MAX_TAIL_LINES)
      .default(DEFAULT_TAIL_LINES)
      .describe(
        `How many trailing lines to return. Default ${DEFAULT_TAIL_LINES}, max ${MAX_TAIL_LINES}. Output is also capped by total size.`,
      ),
  },
  handler: async (args, ctx) => {
    const action = await resolveAction(ctx, args.actionId);
    const { raw, source } = currentOutputOf(action);
    const tail = tailOutput(raw, args.tailLines ?? DEFAULT_TAIL_LINES);

    return {
      data: {
        actionId: action.id,
        name: action.name,
        command: action.command,
        status: action.status,
        isRunning: action.status === 'running',
        source,
        lastExitCode: action.lastExitCode ?? undefined,
        lastFinishedAt: action.lastFinishedAt ?? undefined,
        durationSeconds: runDurationSeconds(action),
        totalLines: tail.totalLines,
        output: tail.text,
      },
      truncated: tail.truncated,
      nextStep:
        action.status === 'running'
          ? 'Still running — poll_action_status to wait for the result instead of re-reading in a loop.'
          : tail.totalLines === 0
            ? 'No output recorded. run_action to execute it.'
            : 'Act on the output: fix the code in a session (prompt_session), then run_action again.',
    };
  },
});
