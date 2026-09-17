import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';

export const listSessionFoldersTool = defineTool({
  name: 'list_session_folders',
  title: 'List session folders',
  costClass: 'instant',
  description:
    'List the sidebar session folders and their session memberships for one repo, optionally narrowed to a workspace. ⚡instant. Use this to discover folder ids before moving, renaming, archiving, restoring, or deleting folders.',
  annotations: { readOnlyHint: true },
  inputShape: {
    repoId: z
      .number()
      .int()
      .positive()
      .describe(
        'Repo whose session folders to list. From project_overview / add_repo.',
      ),
    workspaceId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Optional workspace filter. From link_worktree / create_session.',
      ),
    state: z
      .enum(['active', 'archived', 'all'])
      .default('active')
      .describe("Folder state to include. Default 'active'."),
  },
  handler: async (args, ctx) => {
    const [allFolders, allSessions] = await Promise.all([
      ctx.services.sessionFolders.listByRepo(args.repoId),
      ctx.services.sessions.findByRepo(args.repoId),
    ]);
    const folders = allFolders
      .filter(
        (folder) =>
          args.workspaceId === undefined ||
          folder.workspaceId === args.workspaceId,
      )
      .filter((folder) =>
        args.state === 'all'
          ? true
          : args.state === 'archived'
            ? folder.archivedAt !== null
            : folder.archivedAt === null,
      )
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      data: {
        count: folders.length,
        folders: folders.map((folder) => {
          const members = allSessions.filter(
            (session) => session.folderId === folder.id,
          );
          return {
            id: folder.id,
            name: folder.name,
            repoId: folder.repoId,
            workspaceId: folder.workspaceId,
            archived: folder.archivedAt !== null,
            sessionIds: members
              .filter((session) => session.status !== 'archived')
              .map((session) => session.id),
            archivedSessionIds: members
              .filter((session) => session.status === 'archived')
              .map((session) => session.id),
          };
        }),
      },
      nextStep:
        'Use create_session_folder, move_session_to_folder, rename_session_folder, archive_session_folder, unarchive_session_folder, or delete_session_folder.',
    };
  },
});
