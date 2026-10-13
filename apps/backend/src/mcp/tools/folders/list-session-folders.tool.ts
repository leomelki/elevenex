import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';

export const listSessionFoldersTool = defineTool({
  name: 'list_session_folders',
  title: 'List session folders',
  costClass: 'instant',
  paginated: true,
  description:
    'List the sidebar session folders and their session memberships for one repo, optionally narrowed to a workspace. ⚡instant. Use this to discover folder ids before moving, renaming, archiving, restoring, or deleting folders.',
  annotations: { readOnlyHint: true },
  currentSessionScope: 'repo',
  inputShape: {
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe(
        'Folder page size, default 25; max 100. Each membership preview is capped at 20 IDs.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Folder page offset, default 0.'),
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
        'Optional workspace filter. Task ID (also workspaceId) from get_current_session / get_task.',
      ),
    state: z
      .enum(['active', 'archived', 'all'])
      .default('active')
      .describe("Folder state to include. Default 'active'."),
  },
  handler: async (args, ctx) => {
    const page = ctx.services.sessionFolders.listHandlePage(args.repoId, {
      ...args,
      limit: args.limit ?? 25,
      offset: args.offset ?? 0,
    });
    return Promise.resolve({
      data: { count: page.folders.length, ...page },
      truncated:
        page.nextOffset !== null ||
        page.folders.some(
          (folder) =>
            folder.sessionCount > folder.sessionIds.length ||
            folder.archivedSessionCount > folder.archivedSessionIds.length,
        ),
      nextStep:
        'Memberships are previews. find_sessions with taskId, folderId and state:all pages conversations. Use folder tools to change groups.',
    });
  },
});
