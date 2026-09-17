import { DeltaCursorStore } from '../tool-registry/delta-cursor.store.js';
import { DeepLinkBuilder } from '../deep-link/deep-link.builder.js';
import type { ToolContext } from '../tool-registry/tool.types.js';
import { archiveSessionFolderTool } from '../tools/folders/archive-session-folder.tool.js';
import { createSessionFolderTool } from '../tools/folders/create-session-folder.tool.js';
import { deleteSessionFolderTool } from '../tools/folders/delete-session-folder.tool.js';
import { FOLDER_TOOLS } from '../tools/folders/index.js';
import { listSessionFoldersTool } from '../tools/folders/list-session-folders.tool.js';
import { moveSessionToFolderTool } from '../tools/folders/move-session-to-folder.tool.js';
import { renameSessionFolderTool } from '../tools/folders/rename-session-folder.tool.js';
import { unarchiveSessionFolderTool } from '../tools/folders/unarchive-session-folder.tool.js';

function makeCtx(services: unknown): ToolContext {
  return {
    services,
    agentSessionId: 42,
    caps: {
      isAgent: true,
      canMutate: true,
      canDestroy: true,
      canUseHumanChannel: true,
    },
    cursors: new DeltaCursorStore(),
    deepLink: new DeepLinkBuilder(),
    human: {} as never,
    signal: new AbortController().signal,
    mcpSessionId: 'test',
  } as unknown as ToolContext;
}

const folder = {
  id: 12,
  repoId: 3,
  workspaceId: 7,
  name: 'Review',
  archivedAt: null,
};

describe('Session folder tool group', () => {
  it('exports all seven tools with described inputs and safety flags', () => {
    expect(FOLDER_TOOLS.map((tool) => tool.name)).toEqual([
      'list_session_folders',
      'create_session_folder',
      'rename_session_folder',
      'move_session_to_folder',
      'archive_session_folder',
      'unarchive_session_folder',
      'delete_session_folder',
    ]);
    expect(listSessionFoldersTool.annotations?.readOnlyHint).toBe(true);
    expect(createSessionFolderTool.mutates).toBe(true);
    expect(deleteSessionFolderTool.destructive).toBe(true);
    for (const tool of FOLDER_TOOLS) {
      for (const field of Object.values(tool.inputShape)) {
        expect((field as { description?: string }).description).toBeTruthy();
      }
    }
  });

  it('lists filtered folders with active and archived memberships', async () => {
    const services = {
      sessionFolders: {
        listByRepo: jest
          .fn()
          .mockResolvedValue([
            folder,
            { ...folder, id: 13, name: 'Old', archivedAt: '2026-01-01' },
            { ...folder, id: 14, workspaceId: 8, name: 'Other' },
          ]),
      },
      sessions: {
        findByRepo: jest.fn().mockResolvedValue([
          { id: 20, folderId: 12, status: 'running' },
          { id: 21, folderId: 12, status: 'archived' },
          { id: 22, folderId: null, status: 'created' },
        ]),
      },
    };

    const result = await listSessionFoldersTool.handler(
      { repoId: 3, workspaceId: 7, state: 'active' },
      makeCtx(services),
    );

    expect(services.sessionFolders.listByRepo).toHaveBeenCalledWith(3);
    expect(result.data).toEqual({
      count: 1,
      folders: [
        expect.objectContaining({
          id: 12,
          sessionIds: [20],
          archivedSessionIds: [21],
        }),
      ],
    });
  });

  it('creates and renames a folder', async () => {
    const services = {
      sessionFolders: {
        create: jest.fn().mockResolvedValue(folder),
        rename: jest.fn().mockResolvedValue({ ...folder, name: 'Done' }),
      },
    };
    const ctx = makeCtx(services);

    const created = await createSessionFolderTool.handler(
      { repoId: 3, workspaceId: 7, name: 'Review' },
      ctx,
    );
    const renamed = await renameSessionFolderTool.handler(
      { folderId: 12, name: 'Done' },
      ctx,
    );

    expect(services.sessionFolders.create).toHaveBeenCalledWith({
      repoId: 3,
      workspaceId: 7,
      name: 'Review',
    });
    expect(created.touched).toEqual({ folderId: 12 });
    expect(services.sessionFolders.rename).toHaveBeenCalledWith(12, 'Done');
    expect(renamed.data).toMatchObject({ folderId: 12, name: 'Done' });
  });

  it('moves a session into a folder and supports ungrouping', async () => {
    const moveToFolder = jest
      .fn()
      .mockResolvedValueOnce({ id: 20, folderId: 12, workspaceId: 7 })
      .mockResolvedValueOnce({ id: 20, folderId: null, workspaceId: 7 });
    const ctx = makeCtx({ sessions: { moveToFolder } });

    const moved = await moveSessionToFolderTool.handler(
      { sessionId: 20, folderId: 12 },
      ctx,
    );
    const ungrouped = await moveSessionToFolderTool.handler(
      { sessionId: 20, folderId: null },
      ctx,
    );

    expect(moveToFolder).toHaveBeenNthCalledWith(1, 20, 12);
    expect(moveToFolder).toHaveBeenNthCalledWith(2, 20, null);
    expect(moved.data).toMatchObject({ sessionId: 20, folderId: 12 });
    expect(ungrouped.data).toMatchObject({ sessionId: 20, folderId: null });
    expect(moved.deepLink).toBe('/sessions/20');
  });

  it('archives, restores, and deletes folders through the domain service', async () => {
    const services = {
      sessionFolders: {
        archive: jest
          .fn()
          .mockResolvedValue({ ...folder, archivedAt: '2026-01-01' }),
        unarchive: jest.fn().mockResolvedValue(folder),
        delete: jest
          .fn()
          .mockResolvedValue({ ...folder, deletedSessionIds: [20, 21] }),
      },
    };
    const ctx = makeCtx(services);

    const archived = await archiveSessionFolderTool.handler(
      { folderId: 12 },
      ctx,
    );
    const restored = await unarchiveSessionFolderTool.handler(
      { folderId: 12 },
      ctx,
    );
    const deleted = await deleteSessionFolderTool.handler(
      { folderId: 12 },
      ctx,
    );

    expect(archived.data).toEqual({ folderId: 12, archived: true });
    expect(restored.data).toEqual({ folderId: 12, archived: false });
    expect(deleted.data).toEqual({
      folderId: 12,
      deleted: true,
      deletedSessionIds: [20, 21],
    });
  });
});
