import type { ToolDefinition } from '../tool-registry/tool.types.js';
import { OBSERVE_TOOLS } from './observe/index.js';
import { DRIVE_TOOLS } from './drive/index.js';
import { ASK_TOOLS } from './ask/index.js';
import { SETUP_TOOLS } from './setup/index.js';
import { HUMAN_TOOLS } from './human/index.js';

/**
 * Barrel collecting every elevenex MCP tool. The registry registers exactly
 * this array. Ordered the way the agent composes a mission — observe to orient,
 * set up the environment, drive sessions, ask quick questions — so the tool
 * list reads like the workflow in the server instructions.
 */
export const ALL_TOOLS: ToolDefinition[] = [
  ...OBSERVE_TOOLS,
  ...SETUP_TOOLS,
  ...DRIVE_TOOLS,
  ...ASK_TOOLS,
  ...HUMAN_TOOLS,
];
