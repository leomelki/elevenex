import { z } from 'zod';
import { BROWSER_AGENT_GUIDE, CDP_METHODS } from '@elevenex/browser-agent';
import {
  defineTool,
  ToolError,
  type ToolContext,
} from '../../tool-registry/tool.types.js';

const scope = {
  taskId: z
    .number()
    .int()
    .positive()
    .safe()
    .optional()
    .describe(
      'Task owning the browser; defaults to the authenticated caller’s task.',
    ),
  desktopId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Explicit browser host from the guide response; required when several hosts are connected.',
    ),
};

async function caller(
  taskId: number | undefined,
  ctx: ToolContext,
): Promise<{ taskId: number; sessionId: number }> {
  if (ctx.agentSessionId === null)
    throw new ToolError({
      code: 'requires_agent_session',
      message: 'Browser code needs an authenticated Elevenex session.',
    });
  const session = await ctx.services.sessions.findOne(ctx.agentSessionId);
  const id = taskId ?? session.workspaceId;
  if (!id || session.workspaceId !== id || session.status === 'archived')
    throw new ToolError({
      code: 'browser_scope',
      message:
        'Browser execution must belong to the authenticated session’s active task.',
    });
  const task = await ctx.services.tasks.record(id);
  if (task.taskState !== 'ready' || task.archivedAt)
    throw new ToolError({
      code: 'browser_scope',
      message: 'Reopen the task before using its browser.',
    });
  return { taskId: id, sessionId: ctx.agentSessionId };
}

const browserRun = defineTool({
  name: 'browser_run',
  title: 'Run browser code',
  costClass: 'heavy',
  requiresAgent: true,
  currentSessionScope: 'task',
  mutates: true,
  annotations: { openWorldHint: true, idempotentHint: false },
  description:
    'Run JavaScript against the task browser with real Playwright locators, callbacks, HTTP/WebSocket mocking, assertions, files, inline screenshots and human action/element requests. Batch a workflow in one call. FIRST call without code for the full API and host choices. Top-level await/return; await all operations. No automatic page output. Human takeover revokes access. Never replay interrupted scripts; inspect first.',
  inputShape: {
    ...scope,
    code: z
      .string()
      .max(65536)
      .optional()
      .describe(
        'Async JavaScript body using context, browser, expect, state, emitImage and human. Omit to read the API guide without starting a browser.',
      ),
    timeoutMs: z
      .number()
      .int()
      .min(250)
      .max(60000)
      .default(15000)
      .describe(
        'Total execution deadline in milliseconds, default 15000, cap 60000. Timeout resets code state and preserves tabs.',
      ),
  },
  handler: async (args, ctx) => {
    if (args.code === undefined) {
      const identity = await caller(args.taskId, ctx);
      return {
        data: {
          guide: BROWSER_AGENT_GUIDE,
          cdpMethods: [...CDP_METHODS],
          hosts: ctx.services.browsers.desktops(identity.taskId),
        },
      };
    }
    const identity = await caller(args.taskId, ctx);
    const result = await ctx.services.browsers
      .requestCode(
        identity.taskId,
        identity.sessionId,
        { kind: 'code', api: 2, code: args.code, timeoutMs: args.timeoutMs },
        ctx.signal,
        args.desktopId,
      )
      .catch((error: unknown) => {
        throw new ToolError({
          code: 'browser_execution_stopped',
          message:
            error instanceof Error
              ? error.message
              : 'Browser execution stopped',
          remediation:
            'Read the API/host choices without code and inspect current tabs before trying again. Accepted actions may have completed; never replay a script automatically.',
          retryable: false,
        });
      });
    for (const request of result.requests ?? []) {
      if (request.status === 'pending') await ctx.human.notify({ level: 'warning', message: request.message, deepLink: ctx.deepLink.task(identity.taskId) });
    }
    return {
      data: {
        requests: result.requests,
        sandboxId: result.sandboxId,
        value: result.value,
        logs: result.logs,
        images: result.images.map(({ width, height }, index) => ({
          image: index + 1,
          width,
          height,
        })),
        ...(result.error ? { error: result.error } : {}),
      },
      images: result.images,
      isError: result.error !== undefined,
    };
  },
});

const browserReset = defineTool({
  name: 'browser_reset',
  title: 'Reset browser code state',
  costClass: 'scoped',
  requiresAgent: true,
  currentSessionScope: 'task',
  mutates: true,
  annotations: { idempotentHint: true },
  description:
    'Cancel this conversation’s browser script and discard its JavaScript state/handles. Keeps tabs, profile and human control. Use after stale handles or to release a warm sandbox. Inspect tabs before repeating any interrupted action.',
  inputShape: scope,
  handler: async (args, ctx) => {
    const identity = await caller(args.taskId, ctx);
    return {
      data: await ctx.services.browsers.requestCode(
        identity.taskId,
        identity.sessionId,
        { kind: 'code', code: '', timeoutMs: 1000, reset: true },
        ctx.signal,
        args.desktopId,
      ),
    };
  },
});

const browserWaitUser = defineTool({
  name: 'browser_wait_user', title: 'Wait for browser interaction', costClass: 'heavy', requiresAgent: true,
  currentSessionScope: 'task', annotations: { readOnlyHint: true, idempotentHint: true },
  description: 'Wait for a browser human-request ticket created by human.requestAction/requestElement in browser_run. Event-driven; no script remains blocked. Returns completed/cancelled/expired or still pending at the wait deadline. Never resumes or replays previous code. Reacquire the page or use human.locator(requestId) after completion.',
  inputShape: {
    taskId: scope.taskId,
    requestId: z.string().uuid().describe('Ticket ID returned in browser_run requests or by human.requestAction/requestElement.'),
    timeoutMs: z.number().int().min(1).max(170000).default(120000).describe('Maximum event wait in milliseconds; default 120000, cap 170000. Timeout leaves the request pending.'),
  },
  handler: async (args, ctx) => {
    const identity = await caller(args.taskId, ctx);
    const data = await ctx.services.browsers.waitForUser(identity.taskId, identity.sessionId, args.requestId, args.timeoutMs, ctx.signal);
    const snapshot = data.status === 'completed' ? data.selection?.snapshot : undefined;
    const shared = data.selection?.snapshot ? { ...data, selection: { ...data.selection, snapshot: { reference: data.selection.snapshot.reference, ...(data.selection.snapshot.error ? { error: data.selection.snapshot.error } : {}) } } } : data;
    return { data: shared, ...(snapshot?.jpeg ? { images: [{ data: snapshot.jpeg, mimeType: 'image/jpeg' as const, width: snapshot.reference.image.width, height: snapshot.reference.image.height }] } : {}), nextStep: data.status === 'completed' ? 'Run fresh code. Reacquire the page or call human.locator(requestId). No old code was replayed.' : data.status === 'pending' ? 'The request is still pending; wait again or explicitly cancel it.' : 'Respect the cancelled/expired request; do not automatically repeat it.' };
  },
});

export const BROWSER_TOOLS = [browserRun, browserReset, browserWaitUser];
