import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import {
  actionHandle,
  resolveActionScope,
  type ActionRow,
} from './action.util.js';

/**
 * list_actions — the worktree's saved commands, as compact handles. ⚡instant.
 * The entry point of the actions group: every other action tool takes an
 * `actionId` from here.
 */
export const listActionsTool = defineTool({
  name: 'list_actions',
  title: 'List actions',
  costClass: 'instant',
  description:
    "List a worktree's saved Actions — the named shell commands (build / test / dev server) shown in its Actions panel — with their last run status. ⚡instant. Scope by sessionId or worktreePath. Start here: run_action, set_action, read_action_output and stop_action all take an actionId from this list. Unrelated to get_pending_action/resolve_action, which are a session's permission prompts.",
  annotations: { readOnlyHint: true },
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Session whose worktree's actions to list (preferred). Or pass worktreePath.",
      ),
    worktreePath: z
      .string()
      .min(1)
      .optional()
      .describe('Explicit worktree root. Used when sessionId is omitted.'),
  },
  handler: async (args, ctx) => {
    const { worktreePath, sessionId } = await resolveActionScope(ctx, args);

    const rows = (await ctx.services.actions.listByWorktree(
      worktreePath,
    )) as ActionRow[];
    const actions = rows.map(actionHandle);
    const running = actions.filter((action) => action.isRunning);

    return {
      data: {
        worktreePath,
        count: actions.length,
        runningCount: running.length,
        actions,
      },
      ...(sessionId ? { deepLink: ctx.deepLink.session(sessionId) } : {}),
      nextStep:
        actions.length === 0
          ? 'No actions yet: set_action to create one (e.g. name "test", command "pnpm test").'
          : running.length > 0
            ? 'Wait for a running action with poll_action_status, or read its tail with read_action_output.'
            : 'run_action to execute one, then poll_action_status to wait for the result.',
    };
  },
});
