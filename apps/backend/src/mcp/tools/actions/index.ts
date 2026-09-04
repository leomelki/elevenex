import type { ToolDefinition } from '../../tool-registry/tool.types.js';
import { listActionsTool } from './list-actions.tool.js';
import { setActionTool } from './set-action.tool.js';
import { deleteActionTool } from './delete-action.tool.js';
import { runActionTool } from './run-action.tool.js';
import { pollActionStatusTool } from './poll-action-status.tool.js';
import { stopActionTool } from './stop-action.tool.js';
import { readActionOutputTool } from './read-action-output.tool.js';

/**
 * Actions — the granular primitives for a worktree's saved shell commands (the
 * Actions panel the human uses): list/create/edit/delete them, run and stop
 * them, wait on a run, read its output. This is how the agent verifies work it
 * commissioned — build, test, lint — without borrowing an inner coding session.
 *
 * Ordered the way a mission uses them: look, declare, execute, wait, inspect.
 * `set_action` upserts by name so a resumed mission never duplicates an entry,
 * `run_action` returns a handle instead of blocking, and `poll_action_status`
 * does the waiting event-driven.
 *
 * NOTE: "Action" here is the saved command. The unrelated `get_pending_action`
 * / `resolve_action` pair in the Drive group is about a session's *permission*
 * prompts; the tool descriptions say so explicitly to keep the two apart.
 */
export const ACTION_TOOLS: ToolDefinition[] = [
  listActionsTool,
  setActionTool,
  deleteActionTool,
  runActionTool,
  pollActionStatusTool,
  stopActionTool,
  readActionOutputTool,
];
