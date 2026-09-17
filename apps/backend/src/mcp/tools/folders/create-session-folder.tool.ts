import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { sessionFolderError } from './folder-error.util.js';

export const createSessionFolderTool = defineTool({
  name: 'create_session_folder',
  title: 'Create session folder',
  costClass: 'instant',
  mutates: true,
  description:
    'Create an empty sidebar folder in one workspace. ⚡instant. Follow with move_session_to_folder to add sessions; use list_session_folders to discover existing folders.',
  inputShape: {
    repoId: z
      .number()
      .int()
      .positive()
      .describe(
        'Repo that owns the workspace. From project_overview / add_repo.',
      ),
    workspaceId: z
      .number()
      .int()
      .positive()
      .describe(
        'Workspace where the folder appears. From link_worktree / create_session.',
      ),
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .describe('Folder label, 1-80 characters.'),
  },
  handler: async (args, ctx) => {
    try {
      const folder = await ctx.services.sessionFolders.create(args);
      return {
        data: {
          folderId: folder.id,
          name: folder.name,
          repoId: folder.repoId,
          workspaceId: folder.workspaceId,
          archived: false,
        },
        touched: { folderId: folder.id },
        nextStep: 'Add a session with move_session_to_folder.',
      };
    } catch (error) {
      throw sessionFolderError(
        'create_session_folder_failed',
        error,
        'Verify the repoId/workspaceId pair with project_overview or list_session_folders, and use a non-empty name.',
      );
    }
  },
});
