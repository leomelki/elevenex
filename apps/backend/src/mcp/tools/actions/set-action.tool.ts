import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import {
  actionHandle,
  actionMutationError,
  assertWorktreeExists,
  resolveAction,
  resolveActionScope,
  sameActionName,
  type ActionRow,
} from './action.util.js';

/**
 * set_action — create or update one saved command. ⚡instant, mutates.
 *
 * Idempotent like the other creators in this server: without an `actionId` it
 * upserts on the action's name within the worktree, so a resumed mission that
 * re-declares "test" edits the existing one instead of stacking duplicates in
 * the human's panel.
 */
export const setActionTool = defineTool({
  name: 'set_action',
  title: 'Set action',
  costClass: 'instant',
  mutates: true,
  description:
    'Create or edit a saved Action (a named shell command on a worktree, e.g. name "test" / command "pnpm test"). ⚡instant. Idempotent: without an actionId it updates the worktree action with the same name instead of creating a duplicate — so prefer set_action over delete_action + set_action when fixing a command. Pass actionId to rename/repoint a specific one. Creating does NOT run it: call run_action next.',
  annotations: { idempotentHint: true },
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Session whose worktree owns the action (preferred when creating). Or pass worktreePath. Ignored when actionId is given.',
      ),
    worktreePath: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Explicit worktree root. Required when creating and sessionId is omitted. Ignored when actionId is given.',
      ),
    actionId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Existing action to edit, from list_actions. Omit to create (or upsert by name).',
      ),
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Short label shown in the Actions panel (e.g. "test", "dev server"). Required when creating; the upsert key within a worktree.',
      ),
    command: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Shell command run from the worktree root (e.g. "pnpm test"). Required when creating.',
      ),
  },
  handler: async (args, ctx) => {
    const { actions } = ctx.services;
    const name = args.name?.trim();
    const command = args.command?.trim();

    // Explicit target: edit that action, whatever it is called.
    if (args.actionId !== undefined) {
      // Fail fast with a self-correcting error when the id is bogus.
      await resolveAction(ctx, args.actionId);
      if (!name && !command) {
        throw new ToolError({
          code: 'nothing_to_update',
          message: 'Pass name and/or command to update the action.',
          remediation:
            'Provide the field you want to change, or drop actionId to create a new action.',
        });
      }

      const updated = (await actions
        .update(args.actionId, {
          ...(name ? { name } : {}),
          ...(command ? { command } : {}),
        })
        .catch((error: unknown) => {
          throw actionMutationError(error, {
            code: 'action_update_failed',
            fallbackMessage: `Could not update action ${args.actionId}.`,
            remediation:
              'A running action cannot be edited — stop_action first, then retry.',
          });
        })) as ActionRow;

      return {
        data: { ...actionHandle(updated), created: false, updated: true },
        touched: { actionId: updated.id },
        nextStep:
          'run_action to execute it, or list_actions to review the panel.',
      };
    }

    if (!name || !command) {
      throw new ToolError({
        code: 'action_fields_required',
        message: 'name and command are both required when creating an action.',
        remediation:
          'Pass name + command (plus sessionId or worktreePath), or pass actionId to edit an existing action.',
      });
    }

    const { worktreePath, sessionId } = await resolveActionScope(ctx, args);
    const deepLink = sessionId ? ctx.deepLink.session(sessionId) : undefined;

    // Upsert on name so re-running a mission never duplicates the panel entry.
    const siblings = (await actions.listByWorktree(
      worktreePath,
    )) as ActionRow[];
    const twin = siblings.find((action) => sameActionName(action.name, name));

    if (twin) {
      if (twin.command === command) {
        return {
          data: { ...actionHandle(twin), created: false, updated: false },
          touched: { actionId: twin.id },
          ...(deepLink ? { deepLink } : {}),
          nextStep: `Action "${twin.name}" already exists with this command — run_action to execute it.`,
        };
      }

      const updated = (await actions
        .update(twin.id, { command })
        .catch((error: unknown) => {
          throw actionMutationError(error, {
            code: 'action_update_failed',
            fallbackMessage: `Could not update action ${twin.id}.`,
            remediation:
              'A running action cannot be edited — stop_action first, then retry.',
          });
        })) as ActionRow;

      return {
        data: { ...actionHandle(updated), created: false, updated: true },
        touched: { actionId: updated.id },
        ...(deepLink ? { deepLink } : {}),
        nextStep: `Reused the existing "${updated.name}" action and repointed its command. run_action to execute it.`,
      };
    }

    await assertWorktreeExists(worktreePath);

    const created = (await actions.create({
      worktreePath,
      name,
      command,
    })) as ActionRow;

    return {
      data: { ...actionHandle(created), created: true, updated: false },
      touched: { actionId: created.id },
      ...(deepLink ? { deepLink } : {}),
      nextStep: 'run_action to execute it (it is saved, not started).',
    };
  },
});
