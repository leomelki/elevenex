import { z } from 'zod';
import {
  defineTool,
  ToolError,
  type ToolContext,
  type ToolResultEnvelope,
} from '../../tool-registry/tool.types.js';
import {
  createForwardShape,
  forwardId,
  type ForwardOperation,
} from '../../port-forwarding/port-forwarding.protocol.js';

const scope = {
  projectId: forwardId().describe(
    'Project owning the saved forwards; defaults to the caller’s project.',
  ),
  desktopId: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe(
      'Desktop ID from list_port_forwards. Required when several desktops connect to this backend.',
    ),
};
const target = {
  ...scope,
  forwardId: forwardId().describe(
    'Saved forward ID from list_port_forwards or create_port_forward.',
  ),
};

async function execute(
  operation: ForwardOperation,
  args: { projectId: number; desktopId?: string; [key: string]: unknown },
  ctx: ToolContext,
): Promise<ToolResultEnvelope> {
  const project = await ctx.services.projects.findOne(args.projectId);
  const caller =
    ctx.agentSessionId === null
      ? null
      : await ctx.services.sessions.findOne(ctx.agentSessionId);
  const data = await ctx.services.portForwarding
    .request(
      operation,
      {
        ...args,
        ...(caller
          ? {
              requestedBy: {
                sessionId: caller.id,
                sessionName: (caller.name || 'Agent conversation').slice(
                  0,
                  300,
                ),
              },
            }
          : {}),
      },
      ctx.signal,
      args.desktopId,
    )
    .catch((error: unknown) => {
      if (error instanceof ToolError)
        throw new ToolError({
          code: error.code,
          message: error.message,
          remediation: error.remediation,
          retryable: error.retryable,
          details: {
            ...error.details,
            projectId: args.projectId,
            projectName: project.name,
          },
        });
      throw error;
    });
  return {
    data: { ...data, projectId: args.projectId, projectName: project.name },
    ...(operation !== 'list' && operation !== 'get'
      ? {
          touched: {
            projectId: args.projectId,
            forwardId: data.forwards[0]?.id ?? args.forwardId,
          },
        }
      : {}),
    deepLink: `${ctx.deepLink.project(args.projectId)}#ssh-forwarding`,
    truncated: data.nextOffset !== null,
    nextStep:
      operation === 'remove'
        ? 'The definition is removed. create_port_forward to forward this port again.'
        : data.forwards.some((f) => f.status === 'error')
          ? 'The forward has an error; inspect lastError. Reuse its ID with start_port_forward after fixing the cause.'
          : 'localUrl is on the user’s desktop. An active listener does not prove the remote service is ready; verify the service separately. Use get_port_forward to inspect, stop_port_forward to stop, or remove_port_forward to stop and delete.',
  };
}

export const listPortForwardsTool = defineTool({
  name: 'list_port_forwards',
  title: 'List port forwards',
  costClass: 'scoped',
  requiresAgent: true,
  currentSessionScope: 'project',
  paginated: true,
  description:
    'Discover connected desktops and list this project’s saved port forwards with live status and desktop-local URLs. Returns desktop choices when more than one is connected; pass desktopId to select. Bounded desktop request; use before create/start/stop/remove.',
  inputShape: {
    ...scope,
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Maximum forwards to return; default 25, cap 100.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Pagination offset; default 0. Follow nextOffset.'),
  },
  handler: async (args, ctx) => {
    const project = await ctx.services.projects.findOne(args.projectId);
    const desktops = ctx.services.portForwarding.desktops();
    if (!args.desktopId && desktops.length !== 1)
      return {
        data: {
          projectId: args.projectId,
          projectName: project.name,
          desktops,
          forwards: [],
          selectionRequired: desktops.length > 1,
          available: desktops.length > 0,
        },
        deepLink: `${ctx.deepLink.project(args.projectId)}#ssh-forwarding`,
        nextStep: desktops.length
          ? 'Pass a desktopId to select the desktop where local ports should be opened.'
          : 'Open the Elevenex desktop on this backend. Port-forward listeners live on that desktop; browser-only clients cannot manage them.',
      };
    const result = await execute('list', args, ctx);
    return { ...result, data: { ...(result.data as object), desktops } };
  },
});
export const createPortForwardTool = defineTool({
  name: 'create_port_forward',
  title: 'Create port forward',
  costClass: 'heavy',
  requiresAgent: true,
  mutates: true,
  currentSessionScope: 'project',
  annotations: { idempotentHint: true },
  description:
    'Save and optionally start a TCP forward on the user’s desktop, visible in the project’s Ports UI. Defaults to its current SSH/paired connection, loopback bind, and localPort=remotePort. Reuses an identical definition on retry. Explicit sshHost uses desktop SSH config/agent, never agent-host credentials. Start the remote service separately; inspect returned status/lastError.',
  inputShape: { ...scope, ...createForwardShape },
  handler: (args, ctx) => execute('create', args, ctx),
});

function control(
  operation: 'get' | 'start' | 'stop' | 'remove',
  description: string,
) {
  return defineTool({
    name: `${operation === 'get' ? 'get' : operation}_port_forward`,
    title: `${operation[0].toUpperCase()}${operation.slice(1)} port forward`,
    costClass: operation === 'get' ? 'scoped' : 'heavy',
    requiresAgent: true,
    mutates: operation !== 'get',
    currentSessionScope: 'project',
    annotations: { idempotentHint: true },
    description,
    inputShape: target,
    handler: (args, ctx) => execute(operation, args, ctx),
  });
}
export const getPortForwardTool = control(
  'get',
  'Inspect one saved port forward’s live listener status, desktop-local URL and lastError. Bounded desktop request. Active means the listener is bound, not that the remote service is ready.',
);
export const startPortForwardTool = control(
  'start',
  'Start or retry a saved port forward on the user’s desktop. Already-running listeners are reused. Bounded wait; inspect status and lastError, then verify the remote service separately.',
);
export const stopPortForwardTool = control(
  'stop',
  'Stop a saved desktop port forward while keeping its definition for later start_port_forward. Idempotent; does not stop the remote service.',
);
export const removePortForwardTool = control(
  'remove',
  'Stop a desktop port forward and delete its saved definition from the project’s Ports UI. Repeated removal succeeds if already absent; does not stop the remote service.',
);
export const PORT_FORWARDING_TOOLS = [
  listPortForwardsTool,
  getPortForwardTool,
  createPortForwardTool,
  startPortForwardTool,
  stopPortForwardTool,
  removePortForwardTool,
];
