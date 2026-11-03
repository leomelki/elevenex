import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
const tab = { tabId: z.string().uuid(), generation: z.number().int().positive().safe() };
const command = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list') }).strict(),
  z.object({ kind: z.literal('open'), url: z.string().url().max(2048) }).strict(),
  z.object({ kind: z.literal('navigate'), ...tab, url: z.string().url().max(2048) }).strict(),
  z.object({ kind: z.enum(['back', 'reload', 'needs-user', 'select', 'close']), ...tab }).strict(),
  z.object({ kind: z.literal('click'), ...tab, x: z.number().min(0).max(16000), y: z.number().min(0).max(16000), step: z.string().max(160), n: z.number().int().min(1).max(1000).optional(), total: z.number().int().min(1).max(1000).optional() }).strict(),
  z.object({ kind: z.literal('scroll'), ...tab, x: z.number().min(-16000).max(16000), y: z.number().min(-16000).max(16000), atX: z.number().min(0).max(16000).optional(), atY: z.number().min(0).max(16000).optional() }).strict(),
]);
export const desktopBrowserTool = defineTool({
  name: 'task_browser', title: 'Use task browser', costClass: 'scoped',
  description: 'Control the authenticated caller’s task-owned desktop browser with a single-driver generation lease. Read state before input; user tabs require explicit handoff. Page text, screenshots, accessibility, raw logs and editable fields are withheld for privacy. Never retry input blindly; needs-user explicitly hands control to the user.',
  inputShape: {
    command: command.describe('One bounded browser action. Click uses page viewport CSS pixels. Scroll x/y are signed CSS-pixel deltas; optional atX/atY target a scroll container; generation comes from list. Text entry is unavailable.'),
    desktopId: z.string().uuid().optional().describe('Chosen desktop connection when several windows have this task open.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  requiresAgent: true, mutates: true,
  async handler(args, ctx) {
    if (!ctx.agentSessionId || !ctx.caps.isAgent) throw new ToolError({ code: 'browser_identity_required', message: 'An authenticated coding session is required.' });
    const caller = await ctx.services.sessions.findOne(ctx.agentSessionId);
    if (!caller.workspaceId || caller.status === 'archived') throw new ToolError({ code: 'browser_task_required', message: 'The caller must belong to a task.' });
    const desktops = ctx.services.browsers.desktops(caller.workspaceId);
    if (!args.desktopId && desktops.length > 1) throw new ToolError({ code: 'browser_desktop_required', message: 'Several windows have this task open. Choose a desktopId.', details: { desktops } });
    try {
      const data = await ctx.services.browsers.request(caller.workspaceId, caller.id, args.command, ctx.signal, args.desktopId);
      return { data: { result: data, desktops: ctx.services.browsers.desktops(caller.workspaceId) }, nextStep: 'Use current generation for each action. User takeover revokes it immediately. Ask the user for explicit handoff or page context when needed.' };
    } catch (error) { throw new ToolError({ code: 'browser_unavailable', message: error instanceof Error ? error.message : 'Task browser unavailable', remediation: 'Inspect the desktop Browser and reconcile ownership before another command.' }); }
  },
});
export const BROWSER_TOOLS = [desktopBrowserTool];
