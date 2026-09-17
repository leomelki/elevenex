import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { sessionFolderError } from './folder-error.util.js';

export const moveSessionToFolderTool = defineTool({
  name: 'move_session_to_folder',
  title: 'Move session to folder',
  costClass: 'instant',
  mutates: true,
  description:
    'Move a durable session into a sidebar folder, or pass null to remove it from its folder. ⚡instant. The folder and session must share a workspace.',
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe('Session to move. From find_sessions / list_session_folders.'),
    folderId: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe(
        'Destination folder from list_session_folders, or null to leave the session ungrouped.',
      ),
  },
  handler: async (args, ctx) => {
    try {
      const session = await ctx.services.sessions.moveToFolder(
        args.sessionId,
        args.folderId,
      );
      return {
        data: {
          sessionId: session.id,
          folderId: session.folderId ?? null,
          workspaceId: session.workspaceId,
        },
        touched: { sessionId: session.id, folderId: session.folderId ?? null },
        deepLink: ctx.deepLink.session(session.id),
        nextStep:
          'Call list_session_folders to inspect the updated sidebar grouping.',
      };
    } catch (error) {
      throw sessionFolderError(
        'move_session_to_folder_failed',
        error,
        'Use a durable session and an active folder from the same workspace, or pass folderId:null to ungroup it.',
      );
    }
  },
});
