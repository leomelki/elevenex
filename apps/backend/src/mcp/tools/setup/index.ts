import type { ToolDefinition } from '../../tool-registry/tool.types.js';
import { TASK_TOOLS } from './task.tools.js';
import { findOrCreateProjectTool } from './find-or-create-project.tool.js';
import { addRepoTool } from './add-repo.tool.js';
import { removeRepoTool } from './remove-repo.tool.js';
import { assessWorktreePoolTool } from './assess-worktree-pool.tool.js';
import { createSessionTool } from './create-session.tool.js';
import { generateWorktreeContextTool } from './generate-worktree-context.tool.js';
import { setTodoTool } from './set-todo.tool.js';
import { setScratchpadTool } from './set-scratchpad.tool.js';
import { deleteProjectTool } from './delete-project.tool.js';

/** Tasks own conversations and checkout allocation. Legacy worktree provisioning
 * tools are no longer advertised: they bypass task reservations and history.
 */
export const SETUP_TOOLS: ToolDefinition[] = [
  ...TASK_TOOLS,
  findOrCreateProjectTool,
  addRepoTool,
  removeRepoTool,
  deleteProjectTool,
  assessWorktreePoolTool,
  createSessionTool,
  generateWorktreeContextTool,
  setTodoTool,
  setScratchpadTool,
];
