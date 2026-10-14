import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
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
        'finish_task preserves history. confirmStop:true requires explicit human approval to stop running work. For your own task, userRequested:true is allowed only when the user explicitly asked to finish it; cleanup waits for your final reply.',
    }),
  }),
  defineTool({
    name: 'finish_task',
    title: 'Finish task',
    costClass: 'scoped',
    mutates: true,
    destructive: true,
    description:
      'Finish the whole task: archive all conversations, stop agents/terminals/actions, preserve branch/history, and release clean managed checkouts (dirty/external stay reserved). Does not commit, merge, or push. Use preview_finish_task first. Self-finish requires userRequested:true and queues cleanup until your final reply and background work end; cancel_finish_task can cancel it before cleanup starts. Other tasks finish immediately.',
    inputShape: {
      taskId,
      userRequested: z
        .boolean()
        .default(false)
        .describe(
          'True only when the user explicitly asked to finish this task. Required for finishing your own task; never infer consent from completing the coding work. Default false.',
        ),
      confirmStop: z
        .boolean()
        .default(false)
        .describe(
          'True only after the human explicitly approves stopping running agents, terminals, and actions. Default false.',
        ),
    },
    handler: async (args, ctx) => {
      const caller =
        ctx.agentSessionId === null
          ? null
          : await ctx.services.sessions.findOne(ctx.agentSessionId);
      if (caller?.workspaceId === args.taskId) {
        if (!args.userRequested) {
          throw new ToolError({
            code: 'self_target_not_allowed',
            message:
              'Finishing your own task requires an explicit user request.',
            remediation:
              'Continue working. Only when the user explicitly asks to finish this task, call finish_task with userRequested:true. confirmStop separately authorizes stopping other running work.',
          });
        }
        const data = await taskOperation(() =>
          ctx.services.tasks.finishAfterTurn(
            args.taskId,
            caller.id,
            args.confirmStop,
          ),
        );
        return {
          data,
          touched: { taskId: args.taskId },
          deepLink: ctx.deepLink.task(args.taskId),
          nextStep:
            'Finishing is scheduled, not completed yet, and persists across backend restarts. If more work is needed or you reconsider, call cancel_finish_task before becoming idle; cancellation needs no further user approval. Otherwise send your final reply and end this turn without waiting or polling. Cleanup archives every task conversation, stops task processes, and may release the checkout.',
        };
      }
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
    name: 'cancel_finish_task',
    title: 'Cancel scheduled task finish',
    costClass: 'instant',
    mutates: true,
    requiresAgent: true,
    currentSessionScope: 'task',
    annotations: { idempotentHint: true },
    description:
      'Cancel your conversation’s queued task finish before cleanup starts, including a job waiting on a repository lock or process preview. Use when you reconsider, need more work, or the user withdraws the request; no extra human approval is needed. Clears the durable schedule without stopping processes or changing files. Repeating with no pending request is harmless; cannot cancel another conversation’s request or undo cleanup already started.',
    inputShape: { taskId },
    handler: async (args, ctx) => ({
      data: await taskOperation(() =>
        ctx.services.tasks.cancelScheduledFinish(
          args.taskId,
          ctx.agentSessionId!,
        ),
      ),
      touched: { taskId: args.taskId },
      deepLink: ctx.deepLink.task(args.taskId),
      nextStep:
        'There is no scheduled finish. Continue working normally. To schedule finishing again, use preview_finish_task then finish_task with userRequested:true only if the user still explicitly wants the task finished.',
    }),
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
