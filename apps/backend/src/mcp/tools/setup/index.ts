import type { ToolDefinition } from '../../tool-registry/tool.types.js';
import { findOrCreateProjectTool } from './find-or-create-project.tool.js';
import { addRepoTool } from './add-repo.tool.js';
import { removeRepoTool } from './remove-repo.tool.js';
import { assessWorktreePoolTool } from './assess-worktree-pool.tool.js';
import { createWorktreeTool } from './create-worktree.tool.js';
import { deleteWorktreeTool } from './delete-worktree.tool.js';
import { getWorktreeJobTool } from './get-worktree-job.tool.js';
import { linkWorktreeTool } from './link-worktree.tool.js';
import { renameWorktreeTool } from './rename-worktree.tool.js';
import { stealWorktreeTool } from './steal-worktree.tool.js';
import { switchBranchTool } from './switch-branch.tool.js';
import { createSessionTool } from './create-session.tool.js';
import { generateWorktreeContextTool } from './generate-worktree-context.tool.js';
import { setTodoTool } from './set-todo.tool.js';
import { setScratchpadTool } from './set-scratchpad.tool.js';
import { deleteProjectTool } from './delete-project.tool.js';

/**
 * Setup — the granular primitives that *provision* the environment a mission
 * runs in: projects, repos, the worktree pool (find/create/link/steal),
 * worktree context generation, and lightweight todo/scratchpad bookkeeping.
 * Every creator is find-or-create / idempotent so resumed missions don't
 * duplicate state. Heavy provisioning (create_worktree, generate context)
 * returns a handle to poll instead of blocking.
 */
export const SETUP_TOOLS: ToolDefinition[] = [
  findOrCreateProjectTool,
  addRepoTool,
  removeRepoTool,
  deleteProjectTool,
  assessWorktreePoolTool,
  createWorktreeTool,
  deleteWorktreeTool,
  getWorktreeJobTool,
  linkWorktreeTool,
  renameWorktreeTool,
  stealWorktreeTool,
  switchBranchTool,
  createSessionTool,
  generateWorktreeContextTool,
  setTodoTool,
  setScratchpadTool,
];
