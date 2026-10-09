import { z } from 'zod';
import { HttpException } from '@nestjs/common';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import { TasksService } from '../../../tasks/tasks.service.js';

const taskId = z
  .number()
  .int()
  .positive()
  .describe('Stable task ID from create_task or list_tasks.');
const setupShape = {
  name: z
    .string()
    .max(160)
    .optional()
    .describe(
      'Display name, independent of the branch; defaults to the branch.',
    ),
  mode: z
    .enum(['new', 'existing'])
    .describe('Create a new branch or select an existing local/remote branch.'),
  branchName: z
    .string()
    .min(1)
    .max(240)
    .describe(
      'Branch name; use refs/heads/name or refs/remotes/remote/name to disambiguate an existing branch.',
    ),
  baseRef: z
    .string()
    .max(240)
    .optional()
    .describe(
      'Base branch or revision for a new branch; defaults to the repository default.',
    ),
  checkoutMode: z
    .enum(['branch', 'snapshot'])
    .optional()
    .describe(
      'branch for a live branch, snapshot for an independent committed revision.',
    ),
  environment: z
    .enum(['automatic', 'new'])
    .optional()
    .describe(
      'Automatic clean worktree reuse (default) or a new worktree.',
    ),
  confirmOverLimit: z
    .boolean()
    .optional()
    .describe(
      'True only when the human explicitly approved exceeding the configured worktree limit.',
    ),
  confirmExternal: z
    .boolean()
    .optional()
    .describe(
      'True only when the human explicitly selected using an external checkout.',
    ),
  useSavedRef: z
    .boolean()
    .optional()
    .describe(
      'Explicitly use the locally saved remote revision after a failed refresh.',
    ),
};

function handle(task: Awaited<ReturnType<TasksService['get']>>) {
  return {
    taskId: task.id,
    repoId: task.repoId,
    name: task.name,
    state: task.taskState,
    finishedAt: task.archivedAt,
    branch: task.taskBranch,
    sourceRef: task.sourceRef,
    checkoutMode: task.checkoutMode,
    environmentPath: task.linkStatus === 'linked' ? task.path : null,
    error: task.error,
    sessions: task.sessions.slice(0, 50).map((session) => ({
      sessionId: session.id,
      name: session.name,
      status: session.status,
    })),
  };
}

async function run<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const response = error.getResponse();
    const detail =
      typeof response === 'string'
        ? { message: response }
        : (response as { code?: string; message?: string });
    throw new ToolError({
      code: detail.code || 'task_operation_failed',
      message: detail.message || error.message,
      remediation:
        'Inspect get_task and retry_task with an explicit recovery choice.',
      retryable: error.getStatus() === 409,
    });
  }
}

export const TASK_TOOLS = [
  defineTool({
    name: 'create_task',
    title: 'Create task',
    costClass: 'heavy',
    mutates: true,
    description:
      'Create a named task and prepare its isolated worktree automatically. Returns immediately; poll get_task until ready, then prompt its initial session. Prefer this to worktree provisioning.',
    inputShape: {
      repoId: z.number().int().positive().describe('Repository ID.'),
      requestId: z
        .string()
        .uuid()
        .describe(
          'Caller-generated UUID. Reuse it when retrying the same request to avoid duplicates.',
        ),
      ...setupShape,
    },
    handler: async (args, ctx) => {
      const task = await run(() =>
        ctx.services.tasks.create(args.repoId, args),
      );
      return {
        data: handle(task),
        touched: { taskId: task.id },
        nextStep:
          'Poll get_task. When ready, prompt_session using its initial sessionId.',
      };
    },
  }),
  defineTool({
    name: 'list_tasks',
    title: 'List tasks',
    costClass: 'instant',
    description:
      'List active or finished tasks in one repository without inspecting their checkouts.',
    inputShape: {
      repoId: z.number().int().positive().describe('Repository ID.'),
      state: z
        .enum(['active', 'finished'])
        .default('active')
        .describe('Task lifecycle filter, default active.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(50)
        .describe('Page size.'),
      cursor: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Last task ID from the previous page.'),
    },
    handler: async (args, ctx) => ({
      data: (
        await ctx.services.tasks.list(
          args.repoId,
          args.state,
          args.limit,
          args.cursor,
        )
      ).map((task) => ({
        taskId: task.id,
        name: task.name,
        branch: task.taskBranch,
        state: task.taskState,
        finishedAt: task.archivedAt,
      })),
    }),
  }),
  defineTool({
    name: 'get_task',
    title: 'Get task',
    costClass: 'instant',
    description:
      'Observe task preparation, errors, worktree assignment, and up to 50 conversation handles. Finished task history needs no checkout.',
    inputShape: { taskId },
    handler: async (args, ctx) => ({
      data: handle(await run(() => ctx.services.tasks.get(args.taskId))),
    }),
  }),
  defineTool({
    name: 'rename_task',
    title: 'Rename task',
    costClass: 'instant',
    mutates: true,
    description:
      'Rename the display label of a task without changing its branch or worktree.',
    inputShape: {
      taskId,
      name: z.string().min(1).max(160).describe('New display name.'),
    },
    handler: async (args, ctx) => ({
      data: handle(
        await run(() => ctx.services.tasks.rename(args.taskId, args.name)),
      ),
    }),
  }),
  defineTool({
    name: 'retry_task',
    title: 'Retry task',
    costClass: 'heavy',
    mutates: true,
    description:
      'Retry failed preparation with an explicit recovery choice. Returns immediately; poll get_task.',
    inputShape: {
      taskId,
      ...Object.fromEntries(
        Object.entries(setupShape).map(([key, value]) => [
          key,
          value.optional(),
        ]),
      ),
    } as { taskId: typeof taskId } & {
      [K in keyof typeof setupShape]: z.ZodOptional<(typeof setupShape)[K]>;
    },
    handler: async (args, ctx) => ({
      data: handle(
        await run(() => ctx.services.tasks.retry(args.taskId, args)),
      ),
      nextStep: 'Poll get_task until ready or failed.',
    }),
  }),
  defineTool({
    name: 'finish_task',
    title: 'Finish task',
    costClass: 'heavy',
    mutates: true,
    destructive: true,
    description:
      'Archive a task and stop its processes, preserving its branch and conversations. Dirty worktrees stay reserved. Running work requires explicit confirmation.',
    inputShape: {
      taskId,
      confirmStop: z
        .boolean()
        .default(false)
        .describe(
          'Human explicitly approved stopping running agents, terminals, and actions.',
        ),
    },
    handler: async (args, ctx) => ({
      data: handle(
        await run(() =>
          ctx.services.tasks.finish(args.taskId, args.confirmStop),
        ),
      ),
    }),
  }),
  defineTool({
    name: 'reopen_task',
    title: 'Reopen task',
    costClass: 'heavy',
    mutates: true,
    description:
      'Reopen a finished task with the same identity and conversations. Automatically prepare a worktree; agents remain stopped.',
    inputShape: { taskId },
    handler: async (args, ctx) => ({
      data: handle(await run(() => ctx.services.tasks.reopen(args.taskId))),
      nextStep: 'Poll get_task. Reopening does not start an agent.',
    }),
  }),
];
