import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { sessionFolderError } from './folder-error.util.js';

export const deleteSessionFolderTool = defineTool({
  name: 'delete_session_folder',
  title: 'Delete session folder',
  costClass: 'scoped',
  mutates: true,
  destructive: true,
  description:
    'Permanently delete a sidebar folder and every session in it. 🟡scoped and destructive. To keep the sessions, move them out with move_session_to_folder before deleting.',
  inputShape: {
    folderId: z
      .number()
      .int()
      .positive()
      .describe('Folder to permanently delete. From list_session_folders.'),
  },
  handler: async (args, ctx) => {
    try {
      const deleted = await ctx.services.sessionFolders.delete(args.folderId);
      return {
        data: {
          folderId: deleted.id,
          deleted: true,
          deletedSessionIds: deleted.deletedSessionIds,
        },
        touched: {
          folderId: deleted.id,
          sessionIds: deleted.deletedSessionIds,
        },
        nextStep: 'Call list_session_folders to inspect the remaining folders.',
      };
    } catch (error) {
      throw sessionFolderError(
        'delete_session_folder_failed',
        error,
        'Get a valid folderId from list_session_folders. Move sessions out first if they must be preserved.',
      );
    }
  },
});
