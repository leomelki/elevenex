import type { ToolDefinition } from '../tool-registry/tool.types.js';
import { OBSERVE_TOOLS } from './observe/index.js';
import { DRIVE_TOOLS } from './drive/index.js';
import { ASK_TOOLS } from './ask/index.js';
import { SETUP_TOOLS } from './setup/index.js';
import { ACTION_TOOLS } from './actions/index.js';
import { HUMAN_TOOLS } from './human/index.js';

/**
 * Barrel collecting every elevenex MCP tool. The registry registers exactly
 * this array. Ordered the way the agent composes a mission — observe to orient,
 * set up the environment, drive sessions, ask quick questions, run the
 * worktree's saved commands — so the tool list reads like the workflow in the
 * server instructions.
 */
export const ALL_TOOLS: ToolDefinition[] = [
  ...OBSERVE_TOOLS,
  ...SETUP_TOOLS,
  ...DRIVE_TOOLS,
  ...ASK_TOOLS,
  ...ACTION_TOOLS,
  ...HUMAN_TOOLS,
];
