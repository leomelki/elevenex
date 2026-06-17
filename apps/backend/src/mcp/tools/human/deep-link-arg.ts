import type { ToolContext } from '../../tool-registry/tool.types.js';

/**
 * Shared deep-link resolution for human-channel tools: prefer an explicit
 * `deepLink` the agent already holds (returned by a prior tool), else build one
 * from a sessionId / projectId so the human's "Open" jumps to the right view.
 */
export function resolveDeepLink(
  ctx: ToolContext,
  args: { deepLink?: string; sessionId?: number; projectId?: number },
): string | undefined {
  if (args.deepLink) return args.deepLink;
  if (args.sessionId !== undefined) return ctx.deepLink.session(args.sessionId);
  if (args.projectId !== undefined) return ctx.deepLink.project(args.projectId);
  return undefined;
}
