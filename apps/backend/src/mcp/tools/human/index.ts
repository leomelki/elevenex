import type { ToolDefinition } from '../../tool-registry/tool.types.js';
import { notifyUserTool } from './notify-user.tool.js';
import { showUserTool } from './show-user.tool.js';
import { requestApprovalTool } from './request-approval.tool.js';
import { escalateToUserTool } from './escalate-to-user.tool.js';
import { selectPathsTool } from './select-paths.tool.js';

/**
 * Human channel — the agent→human primitives. All `requiresAgent` (anonymous
 * external clients can't reach a human surface). notify/show are non-blocking
 * FYIs; request_approval/escalate_to_user/select_paths BLOCK on a person via
 * the panel's escalation/picker UI (bridged by AgentChannelGateway).
 */
export const HUMAN_TOOLS: ToolDefinition[] = [
  notifyUserTool,
  showUserTool,
  requestApprovalTool,
  escalateToUserTool,
  selectPathsTool,
];
