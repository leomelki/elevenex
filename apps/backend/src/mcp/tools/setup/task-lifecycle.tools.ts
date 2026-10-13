import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { repoId, retryShape, setupShape, taskId } from './task-shapes.js';
import { taskHandle, taskNextStep, taskOperation } from './task.util.js';

export const TASK_LIFECYCLE_TOOLS = [
  defineTool({
    name: 'create_task',
    title: 'Create task',
    costClass: 'heavy',
    mutates: true,
    currentSessionScope: 'repo',
    annotations: { idempotentHint: true },
    description:
      'Create a task and asynchronously allocate its worktree and initial conversation through the Tasks workflow. Automatically refreshes refs and protects occupied/dirty/external checkouts. Reuse requestId on retries; poll get_task before prompting.',
    inputShape: {
      repoId,
      requestId: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .describe(
          'Stable caller-generated request key (UUID recommended). Reuse for retries of this operation; use a new key for a different task.',
        ),
      ...setupShape,
    },
    handler: async (args, ctx) => {
      const task = await taskOperation(() =>
        ctx.services.tasks.create(args.repoId, args),
      );
      return {
        data: taskHandle(task, ctx),
        touched: { taskId: task.id },
        deepLink: ctx.deepLink.task(task.id),
        nextStep: taskNextStep(task),
      };
    },
  }),
  defineTool({
    name: 'open_task_session',
    title: 'Open task conversation',
    costClass: 'scoped',
    mutates: true,
    currentSessionScope: 'task',
    annotations: { idempotentHint: true },
    description:
      'Return a ready task’s latest non-archived conversation, creating one only if none exists. Does not start the agent. Use after task setup/reopen; create_session explicitly adds another conversation sharing its files.',
    inputShape: { taskId },
    handler: async (args, ctx) => {
      const session = await taskOperation(() =>
        ctx.services.tasks.openConversation(args.taskId),
      );
      return {
        data: {
          taskId: args.taskId,
          sessionId: session.id,
          name: session.name,
          status: session.status,
          provider: session.activeAgentProvider,
        },
        deepLink: ctx.deepLink.session(session.id),
        nextStep:
          session.id === ctx.agentSessionId
            ? 'This is your current conversation; continue in this turn.'
            : 'prompt_session to start work, or read_session to inspect existing history.',
      };
    },
  }),
  defineTool({
    name: 'rename_task',
    title: 'Rename task',
    costClass: 'scoped',
    mutates: true,
    currentSessionScope: 'task',
    description:
      'Rename a task’s display label while preserving its branch, worktree, and conversations. Use this to label work; worktree names and paths are allocator infrastructure.',
    inputShape: {
      taskId,
      name: z
        .string()
        .trim()
        .min(1)
        .max(160)
        .describe('Display name, 1-160 characters.'),
    },
    handler: async (args, ctx) => {
      const task = await taskOperation(() =>
        ctx.services.tasks.rename(args.taskId, args.name),
      );
      return {
        data: taskHandle(task, ctx),
        touched: { taskId: task.id },
        deepLink: ctx.deepLink.task(task.id),
      };
    },
  }),
  defineTool({
    name: 'retry_task',
    title: 'Retry task setup',
    costClass: 'heavy',
    mutates: true,
    description:
      'Retry failed setup with explicit recovery choices: snapshot for an occupied branch, existing+worktreeId for a chosen environment, or confirmations only after human approval. Keeps saved setup fields omitted from the patch; poll get_task.',
    inputShape: { taskId, ...retryShape },
    handler: async ({ taskId: id, ...patch }, ctx) => {
      const task = await taskOperation(() =>
        ctx.services.tasks.retry(id, patch),
      );
      return {
        data: taskHandle(task, ctx),
        touched: { taskId: task.id },
        deepLink: ctx.deepLink.task(task.id),
        nextStep: taskNextStep(task),
      };
    },
  }),
  defineTool({
    name: 'preview_finish_task',
    title: 'Preview task finish',
    costClass: 'scoped',
    currentSessionScope: 'task',
    annotations: { readOnlyHint: true },
    description:
      'Inspect counts of running agents, terminals, and saved actions that finishing a task would stop. No cleanup is performed. Use before finish_task and any stop confirmation.',
    inputShape: { taskId },
    handler: async (args, ctx) => ({
      data: {
        taskId: args.taskId,
        ...(await taskOperation(() =>
          ctx.services.tasks.finishPreview(args.taskId),
        )),
      },
      deepLink: ctx.deepLink.task(args.taskId),
      nextStep:
        'finish_task preserves history. confirmStop:true requires explicit human approval to stop running work. Ask the human to finish your own task from Elevenex after this turn.',
    }),
  }),
  defineTool({
    name: 'finish_task',
    title: 'Finish task',
    costClass: 'scoped',
    mutates: true,
    destructive: true,
    disallowSelfTarget: 'task',
    description:
      'Stop and archive an explicitly targeted task, preserving branch and conversations. Waits for process cleanup; clean managed worktrees are released, dirty/external ones remain reserved. Cannot finish the calling agent’s own task; use preview_finish_task first.',
    inputShape: {
      taskId,
      confirmStop: z
        .boolean()
        .default(false)
        .describe(
          'True only after the human explicitly approves stopping running agents, terminals, and actions. Default false.',
        ),
    },
    handler: async (args, ctx) => {
      const task = await taskOperation(() =>
        ctx.services.tasks.finish(args.taskId, args.confirmStop),
      );
      return {
        data: taskHandle(task, ctx),
        touched: { taskId: task.id },
        deepLink: ctx.deepLink.task(task.id),
        nextStep: taskNextStep(task),
      };
    },
  }),
  defineTool({
    name: 'reopen_task',
    title: 'Reopen task',
    costClass: 'heavy',
    mutates: true,
    description:
      'Reopen a finished task with the same identity and conversations, preparing a reusable checkout asynchronously. Agents remain stopped; poll get_task, then open_task_session. Never rely on its previous environmentPath.',
    inputShape: { taskId },
    handler: async (args, ctx) => {
      const task = await taskOperation(() =>
        ctx.services.tasks.reopen(args.taskId),
      );
      return {
        data: taskHandle(task, ctx),
        touched: { taskId: task.id },
        deepLink: ctx.deepLink.task(task.id),
        nextStep: taskNextStep(task),
      };
    },
  }),
];
