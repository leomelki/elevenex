import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { repoId, taskId } from './task-shapes.js';
import { taskHandle, taskNextStep, taskOperation } from './task.util.js';

export const TASK_DISCOVERY_TOOLS = [
  defineTool({
    name: 'await_task_ready',
    title: 'Wait for task setup',
    costClass: 'heavy',
    currentSessionScope: 'task',
    annotations: { readOnlyHint: true },
    description:
      'Wait up to 170 seconds for accepted task preparation to settle, using the existing setup operation instead of repeated git polls. Returns ready/failed/finished context or timedOut. Cancellation ends the wait, not durable setup.',
    inputShape: {
      taskId,
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(170000)
        .default(30000)
        .describe('Wait duration in milliseconds, 1000-170000; default 30000.'),
    },
    handler: async (args, ctx) => {
      const { task, timedOut } = await taskOperation(() =>
        ctx.services.tasks.waitForPreparation(
          args.taskId,
          args.timeoutMs,
          ctx.signal,
        ),
      );
      return {
        data: { ...taskHandle(task, ctx), timedOut },
        deepLink: ctx.deepLink.task(task.id),
        nextStep: timedOut
          ? 'Setup is still preparing. await_task_ready again, or get_task to inspect its preparation stage.'
          : taskNextStep(task),
      };
    },
  }),
  defineTool({
    name: 'get_task_defaults',
    title: 'Task setup defaults',
    costClass: 'scoped',
    currentSessionScope: 'repo',
    annotations: { readOnlyHint: true },
    description:
      'Suggest the repository base ref and a collision-free branch slug for a task name. Local git reads, no checkout or fetch. Use before create_task in new mode.',
    inputShape: {
      repoId,
      name: z
        .string()
        .trim()
        .max(160)
        .default('')
        .describe(
          'Proposed task name; default empty. Suggestions are not a branch reservation.',
        ),
    },
    handler: async (args, ctx) => ({
      data: await taskOperation(() =>
        ctx.services.tasks.defaults(args.repoId, args.name),
      ),
      nextStep:
        'create_task with mode:"new", these branchName/baseRef values, and a stable requestId.',
    }),
  }),
  defineTool({
    name: 'list_tasks',
    title: 'List tasks',
    costClass: 'instant',
    paginated: true,
    currentSessionScope: 'repo',
    annotations: { readOnlyHint: true },
    description:
      'Page active or finished tasks in one repository without scanning checkouts. Active tasks follow sidebar order; finished tasks are newest first. Follow nextCursor until null; get_task inspects one.',
    inputShape: {
      repoId,
      state: z
        .enum(['active', 'finished'])
        .default('active')
        .describe(
          'Lifecycle filter, default active. Preparation state is separate from finishedAt.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(25)
        .describe('Page size, 1-100; default 25.'),
      cursor: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Last taskId returned by the previous page; opaque position in sidebar/finished order.',
        ),
    },
    handler: async (args, ctx) => {
      const rows = await taskOperation(() =>
        ctx.services.tasks.list(
          args.repoId,
          args.state,
          args.limit,
          args.cursor,
        ),
      );
      // The domain API caps at 100 and has no total count. A full page may have
      // more rows; using its final ID also works when sidebar order differs from IDs.
      const nextCursor = rows.length === args.limit ? rows.at(-1)!.id : null;
      return {
        data: {
          repoId: args.repoId,
          state: args.state,
          count: rows.length,
          nextCursor,
          tasks: rows.map((task) => ({
            taskId: task.id,
            repoId: task.repoId,
            name: task.name,
            branch: task.taskBranch,
            state: task.taskState,
            finishedAt: task.archivedAt,
            checkoutMode: task.checkoutMode,
            linkStatus: task.linkStatus,
            deepLink: ctx.deepLink.task(task.id),
          })),
        },
        nextStep: nextCursor
          ? `Continue list_tasks with cursor=${nextCursor}; a final empty page means the end.`
          : 'get_task for preparation, errors, environment and conversation handles.',
      };
    },
  }),
  defineTool({
    name: 'get_task',
    title: 'Get task',
    costClass: 'scoped',
    currentSessionScope: 'task',
    annotations: { readOnlyHint: true },
    description:
      'Observe one task’s lifecycle, preparation stage, recovery choices, checkout, saved commits, and a bounded page of conversations. Active checkout verification may run git; finished history needs no checkout.',
    inputShape: {
      taskId,
      sessionOffset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe(
          'Conversation page offset; default 0. Follow nextSessionOffset.',
        ),
      sessionLimit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe('Max conversation handles, 1-100; default 20.'),
    },
    handler: async (args, ctx) => {
      const task = await taskOperation(() =>
        ctx.services.tasks.get(args.taskId),
      );
      return {
        data: taskHandle(task, ctx, args.sessionOffset, args.sessionLimit),
        deepLink: ctx.deepLink.task(task.id),
        truncated:
          args.sessionOffset + args.sessionLimit < task.sessions.length,
        nextStep: taskNextStep(task),
      };
    },
  }),
];
