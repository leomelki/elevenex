import type { EventEmitter } from 'node:events';
import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import {
  currentOutputOf,
  resolveAction,
  runDurationSeconds,
  tailOutput,
  type ActionRow,
} from './action.util.js';

/** Cap at ~3 min to stay inside Claude Code's 5-min tool-call timeout. */
const POLL_WAIT_MS = 170_000;
const DEFAULT_TAIL_LINES = 40;
const MAX_TAIL_LINES = 200;

/**
 * poll_action_status — blocking continuation poll for a running action.
 *
 * Waits event-driven on ActionsService's `action-status-changed` (no busy DB
 * loop). Returns the moment the run settles, with the tail of its output so a
 * failure is actionable without a second call; on timeout it returns
 * stillRunning so the agent calls again immediately.
 */
export const pollActionStatusTool = defineTool({
  name: 'poll_action_status',
  title: 'Poll action status',
  costClass: 'heavy',
  description:
    'Block up to 170 s for a running Action to finish (event-driven, not a poll loop). 🔴heavy. Call it after run_action. On completion returns status (success/failed/stopped), exit code, duration and the tail of the output. On timeout returns stillRunning=true — call it again immediately, no sleep in between. Returns straight away if the action is not running, reporting its last run.',
  annotations: { readOnlyHint: true },
  inputShape: {
    actionId: z
      .number()
      .int()
      .positive()
      .describe('Action to wait on, from run_action or list_actions.'),
    tailLines: z
      .number()
      .int()
      .min(1)
      .max(MAX_TAIL_LINES)
      .default(DEFAULT_TAIL_LINES)
      .describe(
        `Trailing output lines to return on completion. Default ${DEFAULT_TAIL_LINES}, max ${MAX_TAIL_LINES}; read_action_output returns more.`,
      ),
  },
  handler: async (args, ctx) => {
    const tailLines = args.tailLines ?? DEFAULT_TAIL_LINES;
    const action = await resolveAction(ctx, args.actionId);

    // Nothing to wait for — report the last run rather than blocking 170 s.
    if (action.status !== 'running') {
      return settledResult(action, tailLines);
    }

    const emitter = ctx.services.actions as unknown as EventEmitter;

    return new Promise((resolve) => {
      let settled = false;
      // Set once the handlers below exist; cleanup only ever reads it later.
      let timer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        emitter.off('action-status-changed', onStatusChanged);
        ctx.signal.removeEventListener('abort', onAbort);
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      };

      const finish = async (reason: 'settled' | 'timeout' | 'aborted') => {
        if (settled) return;
        settled = true;
        cleanup();

        if (reason === 'settled') {
          // Re-read: the event fires after the row is persisted, so this is the
          // authoritative exit code / output.
          const fresh = await ctx.services.actions
            .findOne(args.actionId)
            .catch(() => null);
          if (fresh) {
            resolve(settledResult(fresh, tailLines));
            return;
          }
        }

        resolve({
          data: {
            actionId: args.actionId,
            name: action.name,
            stillRunning: true,
          },
          nextStep:
            'Still running. Call poll_action_status again immediately — each call already waits up to 170 s.',
        });
      };

      const onStatusChanged = (event: { actionId: number; status: string }) => {
        if (event.actionId !== args.actionId) return;
        if (event.status !== 'running') void finish('settled');
      };

      const onAbort = () => void finish('aborted');

      emitter.on('action-status-changed', onStatusChanged);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => void finish('timeout'), POLL_WAIT_MS);

      if (ctx.signal.aborted) {
        onAbort();
        return;
      }

      // Close the race between the read above and the listener being attached.
      void ctx.services.actions
        .findOne(args.actionId)
        .then((row) => {
          if ((row as ActionRow).status !== 'running') void finish('settled');
        })
        .catch(() => undefined);
    });
  },
});

/** Terminal payload: what happened, and enough output to act on it. */
function settledResult(action: ActionRow, tailLines: number) {
  const { raw } = currentOutputOf(action);
  const tail = tailOutput(raw, tailLines);
  const succeeded = action.status === 'success';

  return {
    data: {
      actionId: action.id,
      name: action.name,
      command: action.command,
      status: action.status,
      stillRunning: false,
      exitCode: action.lastExitCode ?? undefined,
      finishedAt: action.lastFinishedAt ?? undefined,
      durationSeconds: runDurationSeconds(action),
      totalLines: tail.totalLines,
      outputTail: tail.text,
    },
    truncated: tail.truncated,
    nextStep: succeeded
      ? 'Action succeeded. Continue the mission; read_action_output only if you need the full log.'
      : action.status === 'idle'
        ? 'This action has never run. run_action to start it.'
        : 'Action did not succeed: read_action_output for more of the log, then prompt_session to get it fixed.',
  };
}
