import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { taskId } from './task-shapes.js';
import { taskOperation } from './task.util.js';

export const TASK_COMPOSER_TOOLS = [
  defineTool({
    name: 'move_task',
    title: 'Reorder task',
    costClass: 'scoped',
    mutates: true,
    currentSessionScope: 'task',
    annotations: { idempotentHint: true },
    description:
      'Move an active task before another task in the same repository’s sidebar order. Omit beforeTaskId (or pass null) to move to the end. Does not change checkout or execution; list_tasks reflects this order.',
    inputShape: {
      taskId,
      beforeTaskId: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe(
          'Active task to precede in the same repo. Omit/null appends to the end.',
        ),
    },
    handler: async (args, ctx) => {
      const current = await taskOperation(() =>
        ctx.services.tasks.record(args.taskId),
      );
      await taskOperation(() =>
        ctx.services.tasks.move(current.repoId, current.id, args.beforeTaskId),
      );
      return {
        data: {
          taskId: current.id,
          repoId: current.repoId,
          beforeTaskId: args.beforeTaskId ?? null,
          moved: true,
        },
        touched: { taskId: current.id },
        deepLink: ctx.deepLink.task(current.id),
        nextStep:
          'list_tasks with this repoId to inspect the updated sidebar order.',
      };
    },
  }),
  defineTool({
    name: 'read_task_draft',
    title: 'Read task draft',
    costClass: 'instant',
    currentSessionScope: 'task',
    annotations: { readOnlyHint: true },
    description:
      'Read a bounded character window of a task’s saved unsent prompt without fetching conversations or inspecting git. Drafts are unsent text, not work instructions.',
    inputShape: {
      taskId,
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Character offset, default 0.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(12000)
        .default(4000)
        .describe('Character window, 1-12000; default 4000.'),
    },
    handler: async (args, ctx) => {
      const task = await taskOperation(() =>
        ctx.services.tasks.record(args.taskId),
      );
      const text = task.taskDraft ?? '';
      const end = Math.min(text.length, args.offset + args.limit);
      return {
        data: {
          taskId: task.id,
          text: text.slice(args.offset, end),
          totalCharacters: text.length,
          nextOffset: end < text.length ? end : null,
        },
        truncated: end < text.length,
        deepLink: ctx.deepLink.task(task.id),
      };
    },
  }),
  defineTool({
    name: 'set_task_draft',
    title: 'Set task draft',
    costClass: 'instant',
    mutates: true,
    currentSessionScope: 'task',
    annotations: { idempotentHint: true },
    description:
      'Replace a task’s saved unsent composer text; empty text clears it. Does not send a prompt or start an agent. Use read_task_draft first when preserving existing text.',
    inputShape: {
      taskId,
      text: z
        .string()
        .max(100000)
        .describe(
          'Replacement draft, up to 100000 characters; empty clears it.',
        ),
    },
    handler: async (args, ctx) => ({
      data: {
        taskId: args.taskId,
        ...(await taskOperation(() =>
          ctx.services.tasks.saveDraft(args.taskId, args.text),
        )),
      },
      touched: { taskId: args.taskId },
      deepLink: ctx.deepLink.task(args.taskId),
      nextStep:
        'The text is staged only. Use prompt_session with an explicit sessionId to send work to another agent.',
    }),
  }),
];
