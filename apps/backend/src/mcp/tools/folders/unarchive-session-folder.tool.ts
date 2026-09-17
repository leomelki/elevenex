import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { sessionFolderError } from './folder-error.util.js';

export const unarchiveSessionFolderTool = defineTool({
  name: 'unarchive_session_folder',
  title: 'Restore session folder',
  costClass: 'scoped',
  mutates: true,
  description:
    'Restore an archived sidebar folder and the sessions archived with it. 🟡scoped. Its workspace must still be linked; get folderId from list_session_folders with archived state.',
  inputShape: {
    folderId: z
      .number()
      .int()
      .positive()
      .describe(
        "Archived folder to restore. From list_session_folders with state:'archived'.",
      ),
  },
  handler: async (args, ctx) => {
    try {
      const folder = await ctx.services.sessionFolders.unarchive(args.folderId);
      return {
        data: { folderId: folder.id, archived: false },
        touched: { folderId: folder.id },
        nextStep: 'Call list_session_folders to inspect the restored folder.',
      };
    } catch (error) {
      throw sessionFolderError(
        'unarchive_session_folder_failed',
        error,
        'Ensure the folder exists and link its workspace back to the worktree before restoring it.',
      );
    }
  },
});
