import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { sessionFolderError } from './folder-error.util.js';

export const archiveSessionFolderTool = defineTool({
  name: 'archive_session_folder',
  title: 'Archive session folder',
  costClass: 'scoped',
  mutates: true,
  description:
    'Stop and archive a sidebar folder together with its active sessions; this is reversible with unarchive_session_folder. 🟡scoped. Get folderId from list_session_folders.',
  inputShape: {
    folderId: z
      .number()
      .int()
      .positive()
      .describe('Folder to archive. From list_session_folders.'),
  },
  handler: async (args, ctx) => {
    try {
      const folder = await ctx.services.sessionFolders.archive(args.folderId);
      return {
        data: { folderId: folder.id, archived: true },
        touched: { folderId: folder.id },
        nextStep:
          "Call list_session_folders with state:'archived' to inspect it, or unarchive_session_folder to restore it.",
      };
    } catch (error) {
      throw sessionFolderError(
        'archive_session_folder_failed',
        error,
        'Get a valid active folderId from list_session_folders and retry.',
      );
    }
  },
});
