import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { sessionFolderError } from './folder-error.util.js';

export const renameSessionFolderTool = defineTool({
  name: 'rename_session_folder',
  title: 'Rename session folder',
  costClass: 'instant',
  mutates: true,
  description:
    'Rename a sidebar session folder. ⚡instant. Get folderId from list_session_folders.',
  inputShape: {
    folderId: z
      .number()
      .int()
      .positive()
      .describe('Folder to rename. From list_session_folders.'),
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .describe('New folder label, 1-80 characters.'),
  },
  handler: async (args, ctx) => {
    try {
      const folder = await ctx.services.sessionFolders.rename(
        args.folderId,
        args.name,
      );
      return {
        data: {
          folderId: folder.id,
          name: folder.name,
          workspaceId: folder.workspaceId,
        },
        touched: { folderId: folder.id },
        nextStep:
          'Call list_session_folders to inspect the updated sidebar grouping.',
      };
    } catch (error) {
      throw sessionFolderError(
        'rename_session_folder_failed',
        error,
        'Get a valid folderId from list_session_folders and use a non-empty name.',
      );
    }
  },
});
