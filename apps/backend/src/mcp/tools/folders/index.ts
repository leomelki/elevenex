import type { ToolDefinition } from '../../tool-registry/tool.types.js';
import { archiveSessionFolderTool } from './archive-session-folder.tool.js';
import { createSessionFolderTool } from './create-session-folder.tool.js';
import { deleteSessionFolderTool } from './delete-session-folder.tool.js';
import { listSessionFoldersTool } from './list-session-folders.tool.js';
import { moveSessionToFolderTool } from './move-session-to-folder.tool.js';
import { renameSessionFolderTool } from './rename-session-folder.tool.js';
import { unarchiveSessionFolderTool } from './unarchive-session-folder.tool.js';

/** Sidebar folder lifecycle and session grouping primitives. */
export const FOLDER_TOOLS: ToolDefinition[] = [
  listSessionFoldersTool,
  createSessionFolderTool,
  renameSessionFolderTool,
  moveSessionToFolderTool,
  archiveSessionFolderTool,
  unarchiveSessionFolderTool,
  deleteSessionFolderTool,
];
