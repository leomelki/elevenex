import { z } from 'zod';
import { getBackendRuntimeMode } from '../../../config/backend-runtime-mode.js';
import {
  defineTool,
  ToolError,
  type ToolContext,
} from '../../tool-registry/tool.types.js';

const taskScope = {
  taskId: z
    .number()
    .int()
    .positive()
    .safe()
    .optional()
    .describe('Task ID. Defaults to the authenticated coding session’s task.'),
};
const runScope = {
  ...taskScope,
  runId: z
    .string()
    .uuid()
    .describe('Run ID returned by start_app or list_apps.'),
};
const shared = { requiresAgent: true, currentSessionScope: 'task' as const };
const read = {
  ...shared,
  costClass: 'scoped' as const,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

async function caller(ctx: ToolContext, taskId?: number) {
  if (ctx.agentSessionId === null)
    throw new ToolError({
      code: 'requires_agent_session',
      message: 'Apps require an authenticated coding session.',
    });
  const session = await ctx.services.sessions.findOne(ctx.agentSessionId);
  if (
    !session.workspaceId ||
    session.status === 'archived' ||
    session.surface === 'agent' ||
    (taskId !== undefined && taskId !== session.workspaceId)
  )
    throw new ToolError({
      code: 'app_scope',
      message: 'Choose an app in the current coding task.',
    });
  return { id: session.workspaceId, session };
}

/** An argv launch uses the backend user. Never silently broaden a provider sandbox. */
async function authorizeLaunch(ctx: ToolContext, taskId: number) {
  const { session } = await caller(ctx, taskId);
  const provider = ctx.services.agentRuntime.getProvider(session.activeAgentProvider);
  const policy = provider.nativeAppLaunchPolicy?.(session.id) ?? 'request';
  if (session.planMode || policy === 'plan')
    throw new ToolError({
      code: 'app_launch_permissions',
      message: 'Switch out of plan mode before requesting an app launch.',
    });
  ctx.signal.throwIfAborted();
  return policy;
}
const argument = z
  .string()
  .max(2048)
  .refine((value) => !value.includes('\0'), 'Invalid program argument.');

export const startAppTool = defineTool({
  ...shared,
  name: 'start_app',
  title: 'Start app',
  costClass: 'heavy',
  mutates: true,
  description:
    'Launch a graphical application in the current task checkout. Remote tasks open in the Apps viewer and local tasks open natively. A restricted coding session prepares an exact launch for the user to open and approve in Apps. Supply actionId to run an existing saved Action with its normal status and output, or use an executable and separate arguments. If the reply is interrupted, list_apps before retrying with the same requestId.',
  inputShape: {
    ...taskScope,
    requestId: z
      .string()
      .uuid()
      .describe(
        'Unique launch request UUID. Reuse this value for the same launch after an interrupted reply.',
      ),
    actionId: z
      .number()
      .int()
      .positive()
      .safe()
      .optional()
      .describe(
        'Saved Action owned by this checkout. Its saved command and name are used.',
      ),
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('Short app name for the viewer.'),
    executable: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => !value.includes('\0'))
      .optional()
      .describe(
        'Executable to start, such as pnpm. Resolved on the task machine.',
      ),
    presentation: z
      .enum(['auto', 'stream'])
      .default('auto')
      .describe(
        'Automatic opens a native window on a graphical local machine. Stream presents it in Apps, using a private display on Linux.',
      ),
    virtualDisplay: z.object({
      width: z.number().int().min(240).max(1920).multipleOf(2),
      height: z.number().int().min(240).max(1920).multipleOf(2),
    }).strict().refine(size => size.width * size.height <= 1920 * 1080).optional()
      .describe('Optional headless Linux display geometry. Defaults to 1280×800 for apps and 720×1280 for an Android virtual device.'),
    androidAvd: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
      .optional()
      .describe(
        'Launch this installed Android virtual device with disposable data instead of supplying an executable.',
      ),
    args: z
      .array(argument)
      .max(64)
      .default([])
      .describe(
        'Program arguments, such as ["desktop:dev"]. Each entry is one argument.',
      ),
  },
  handler: async (args, ctx) => {
    const { id, session } = await caller(ctx, args.taskId);
    if (
      [args.executable, args.androidAvd, args.actionId].filter(
        (value) => value !== undefined,
      ).length !== 1 ||
      (!args.executable && args.args.length)
    )
      throw new ToolError({
        code: 'invalid_app',
        message:
          'Choose an executable and arguments, a saved Action ID, or an Android virtual device.',
      });
    const checkout = await ctx.services.tasks.record(id);
    const command = args.actionId
      ? await ctx.services.actions.appCommand(id, checkout.path, args.actionId)
      : {
          executable: args.executable ?? 'emulator',
          args: args.args,
          name: args.androidAvd ?? args.executable ?? 'App',
        };
    const run = await ctx.services.tasks.startApp(
      session.id,
      checkout,
      {
        ...command,
        requestId: args.requestId,
        name: args.name ?? command.name.slice(0, 100),
        ...(args.androidAvd ? { android: { avd: args.androidAvd } } : {}),
        ...(args.virtualDisplay ? { virtualDisplay: args.virtualDisplay } : {}),
        mode:
          args.virtualDisplay || args.presentation === 'stream' ||
          getBackendRuntimeMode() === 'remote' ||
          (process.platform === 'linux' &&
            !process.env.DISPLAY &&
            !process.env.WAYLAND_DISPLAY)
            ? 'stream'
            : 'native',
      },
      () => authorizeLaunch(ctx, id),
    );
    return {
      data: { run, openApp: `[Open app](elevenex-app:${run.runId})` },
      nextStep: run.setupIssue
        ? 'Include the Open app link and explain the setup required on the task machine. The user can follow the steps in Apps, then check and launch there.'
        : 'Include the Open app link in your reply. If requested, the user can approve the exact command there. Use get_app for run state and read_app_output for startup errors.',
    };
  },
});
export const listAppsTool = defineTool({
  ...read,
  name: 'list_apps',
  title: 'List apps',
  description: 'List current and recent app runs in the authenticated task.',
  inputShape: taskScope,
  handler: async (args, ctx) => ({
    data: { runs: ctx.services.apps.list((await caller(ctx, args.taskId)).id) },
  }),
});
export const getAppTool = defineTool({
  ...read,
  name: 'get_app',
  title: 'Get app',
  description: 'Read an app run. Pass its last status to wait for a lifecycle or host setup change. A timeout returns the current run without restarting it.',
  inputShape: {
    ...runScope,
    afterStatus: z.enum(['requested','starting','running','stopping','exited','failed']).optional().describe('Wait only while the run still has this status.'),
    timeoutMs: z.number().int().min(1).max(170000).default(30000).describe('Maximum wait in milliseconds when afterStatus is supplied.'),
  },
  handler: async (args, ctx) => {
    const { id } = await caller(ctx, args.taskId);
    const run = args.afterStatus
      ? await ctx.services.apps.waitForChange(id, args.runId, args.afterStatus, args.timeoutMs, ctx.signal)
      : ctx.services.apps.get(id, args.runId);
    return { data: run };
  },
});
export const readAppOutputTool = defineTool({
  ...read,
  name: 'read_app_output',
  title: 'Read app output',
  description: 'Read the bounded recent output of an app run in your task.',
  inputShape: runScope,
  handler: async (args, ctx) => ({
    data: {
      output: ctx.services.apps.output(
        (await caller(ctx, args.taskId)).id,
        args.runId,
      ),
    },
  }),
});
export const stopAppTool = defineTool({
  ...shared,
  name: 'stop_app',
  title: 'Stop app',
  costClass: 'scoped',
  mutates: true,
  description:
    'Stop a task app and its owned helpers. Closing a viewer leaves the app running.',
  inputShape: runScope,
  handler: async (args, ctx) => {
    const { id } = await caller(ctx, args.taskId);
    await ctx.services.apps.stop(id, args.runId);
    return { data: ctx.services.apps.get(id, args.runId) };
  },
});
export const APP_TOOLS = [
  startAppTool,
  listAppsTool,
  getAppTool,
  readAppOutputTool,
  stopAppTool,
];
