import type { ToolDefinition } from '../../tool-registry/tool.types.js';
import { SESSION_LABEL_TOOLS } from './session-label.tools.js';
import { promptSessionTool } from './prompt-session.tool.js';
import { interruptSessionTool } from './interrupt-session.tool.js';
import { resumePendingPromptsTool } from './resume-pending-prompts.tool.js';
import { stopBackgroundTaskTool } from './stop-background-task.tool.js';
import { forkSessionTool } from './fork-session.tool.js';
import { archiveSessionTool } from './archive-session.tool.js';
import { resetSessionTool } from './reset-session.tool.js';
import { getPendingActionTool } from './get-pending-action.tool.js';
import { resolveActionTool } from './resolve-action.tool.js';
import { setProviderTool } from './set-provider.tool.js';
import { setModelTool } from './set-model.tool.js';
import { setPermissionModeTool } from './set-permission-mode.tool.js';

/**
 * Drive — the granular primitives that *act on* a session: trigger/continue it,
 * steer its run, resolve its prompts, and configure its agent. The meta-agent
 * composes these around the read-only Observe group.
 */
export const DRIVE_TOOLS: ToolDefinition[] = [
  ...SESSION_LABEL_TOOLS,
  promptSessionTool,
  interruptSessionTool,
  resumePendingPromptsTool,
  stopBackgroundTaskTool,
  forkSessionTool,
  archiveSessionTool,
  resetSessionTool,
  getPendingActionTool,
  resolveActionTool,
  setProviderTool,
  setModelTool,
  setPermissionModeTool,
];
