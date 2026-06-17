import type { ToolDefinition } from '../tool-registry/tool.types.js';
import { projectOverviewTool } from './observe/project-overview.tool.js';
import { findSessionsTool } from './observe/find-sessions.tool.js';

/**
 * Barrel collecting every elevenex MCP tool. The registry registers exactly
 * this array. Tool groups (observe / drive / setup / human) append their
 * definitions here; keep them grouped and ordered the way the agent composes
 * them so the tool list reads like a workflow.
 */
export const ALL_TOOLS: ToolDefinition[] = [
  // --- Observe ---
  projectOverviewTool,
  findSessionsTool,
];
