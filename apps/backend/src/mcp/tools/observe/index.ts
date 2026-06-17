import type { ToolDefinition } from '../../tool-registry/tool.types.js';
import { projectOverviewTool } from './project-overview.tool.js';
import { findSessionsTool } from './find-sessions.tool.js';
import { sessionStatusTool } from './session-status.tool.js';
import { readSessionTool } from './read-session.tool.js';
import { textSearchTool } from './text-search.tool.js';
import { fileSearchTool } from './file-search.tool.js';
import { readFileTool } from './read-file.tool.js';
import { changeReviewTool } from './change-review.tool.js';
import { getWorktreeContextTool } from './get-worktree-context.tool.js';
import { awaitSessionEventTool } from './await-session-event.tool.js';

/**
 * The Observe tool group: read-only primitives for orienting, polling, reading
 * transcripts/files/diffs, and waiting on session events — all token-economical
 * (compact handles, deltas, counts; hard caps with narrow-scope nextSteps).
 */
export const OBSERVE_TOOLS: ToolDefinition[] = [
  projectOverviewTool,
  findSessionsTool,
  sessionStatusTool,
  readSessionTool,
  textSearchTool,
  fileSearchTool,
  readFileTool,
  changeReviewTool,
  getWorktreeContextTool,
  awaitSessionEventTool,
];
