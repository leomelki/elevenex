import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../database/schema/index.js';
import type { DrizzleDB } from '../../database/database.provider.js';
import { querySessionHandles } from '../../sessions/session-handle-query.js';
import { ScratchpadService } from '../../scratchpad/scratchpad.service.js';
import { TodosService } from '../../todos/todos.service.js';
import { querySessionFolders } from '../../sessions/session-folder-query.js';
import { ReposService } from '../../repos/repos.service.js';
import { eq } from 'drizzle-orm';
import { SessionFoldersService } from '../../sessions/session-folders.service.js';

describe('SQL-backed agent discovery', () => {
  let sqlite: InstanceType<typeof Database>;
  let db: DrizzleDB;
  let projectId: number;
  let repoId: number;
  let taskId: number;
  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: resolve(__dirname, '../../../drizzle') });
    projectId = db
      .insert(schema.projects)
      .values({ name: 'Project' })
      .returning()
      .get().id;
    repoId = db
      .insert(schema.repos)
      .values({ projectId, name: 'Repo', path: '/repo' })
      .returning()
      .get().id;
    taskId = db
      .insert(schema.workspaces)
      .values({ repoId, name: 'Task', path: '/worktree' })
      .returning()
      .get().id;
  });
  afterEach(() => sqlite.close());

  function session(
    overrides: Partial<typeof schema.sessions.$inferInsert> = {},
  ) {
    return db
      .insert(schema.sessions)
      .values({
        repoId,
        workspaceId: taskId,
        name: 'Conversation',
        branchName: 'main',
        worktreePath: '/worktree',
        lastStateChangeAt: '2026-10-13',
        mcpAgentToken: 'secret',
        ...overrides,
      })
      .returning()
      .get();
  }

  it('pages handles in deterministic activity order and excludes hidden/history by default', async () => {
    const first = session();
    const second = session();
    session({ surface: 'agent' });
    session({ status: 'archived' });
    const finished = db
      .insert(schema.workspaces)
      .values({
        repoId,
        name: 'Finished',
        path: '/old',
        archivedAt: '2026-10-12',
      })
      .returning()
      .get();
    session({ workspaceId: finished.id });
    const page = await querySessionHandles(db, { repoId, limit: 1 });
    expect(page).toMatchObject({
      total: 2,
      nextOffset: 1,
      rows: [{ id: second.id }],
    });
    expect(JSON.stringify(page)).not.toContain('secret');
    expect(
      (await querySessionHandles(db, { repoId, limit: 1, offset: 1 })).rows[0]
        .id,
    ).toBe(first.id);
    expect(
      (await querySessionHandles(db, { repoId, state: 'all' })).total,
    ).toBe(4);
  });

  it('applies task, project, folder, status and attention filters before pagination', async () => {
    const folder = db
      .insert(schema.sessionFolders)
      .values({ repoId, workspaceId: taskId, name: 'Group' })
      .returning()
      .get();
    const wanted = session({
      folderId: folder.id,
      status: 'archived',
      hasUnreviewedCompletion: true,
    });
    session({
      folderId: folder.id,
      status: 'archived',
      hasUnreviewedCompletion: false,
    });
    session({ status: 'archived', hasUnreviewedCompletion: true });
    expect(
      await querySessionHandles(db, {
        taskId,
        folderId: folder.id,
        state: 'all',
        status: 'archived',
        needsReviewOnly: true,
        limit: 1,
      }),
    ).toMatchObject({ total: 1, nextOffset: null, rows: [{ id: wanted.id }] });
    expect(
      (await querySessionHandles(db, { projectId, state: 'archived' })).total,
    ).toBe(3);
    expect(
      (
        await querySessionHandles(db, {
          projectId: projectId + 1,
          state: 'all',
        })
      ).rows,
    ).toEqual([]);
  });

  it('reads a note window directly and never loads full note bodies into a listing', async () => {
    const service = new ScratchpadService(db, {} as never);
    const note = db
      .insert(schema.scratchpadSections)
      .values({
        projectId,
        name: 'Large note',
        content: '🙂' + 'x'.repeat(100000),
      })
      .returning()
      .get();
    db.insert(schema.scratchpadSections)
      .values({ projectId, name: 'Second', content: 'abc' })
      .run();
    expect(await service.listHandles(projectId, 0, 1)).toMatchObject({
      total: 2,
      nextOffset: 1,
      sections: [{ sectionId: note.id, contentLength: 100001 }],
    });
    const handles = await service.listHandles(projectId);
    expect(handles.sections[0]).not.toHaveProperty('content');
    expect(await service.readWindow(projectId, note.id, 0, 4)).toMatchObject({
      content: '🙂xxx',
      totalCharacters: 100001,
    });
    expect(await service.readWindow(projectId + 1, note.id, 0, 4)).toBeNull();
  });

  it('filters and pages checklist items in SQL', async () => {
    const service = new TodosService(db, {} as never);
    db.insert(schema.todoItems)
      .values([
        { projectId, text: 'Done', completed: true },
        { projectId, text: 'Open 1' },
        { projectId, text: 'Open 2' },
      ])
      .run();
    expect(await service.listHandles(projectId, 'open', 0, 1)).toMatchObject({
      total: 2,
      nextOffset: 1,
      todos: [{ text: 'Open 1' }],
    });
    expect(await service.listHandles(projectId, 'completed')).toMatchObject({
      total: 1,
      todos: [{ text: 'Done', completed: true }],
    });
  });

  it('bounds folder membership previews while counting all active and archived conversations', () => {
    const folder = db
      .insert(schema.sessionFolders)
      .values({ repoId, workspaceId: taskId, name: 'Group' })
      .returning()
      .get();
    for (let i = 0; i < 55; i++)
      session({ folderId: folder.id, status: i < 30 ? 'running' : 'archived' });
    session({ folderId: folder.id, surface: 'agent_query' });
    const page = querySessionFolders(db, repoId, {
      state: 'active',
      offset: 0,
      limit: 1,
    });
    expect(page).toMatchObject({
      total: 1,
      folders: [{ sessionCount: 30, archivedSessionCount: 25 }],
    });
    expect(page.folders[0].sessionIds).toHaveLength(20);
    expect(page.folders[0].archivedSessionIds).toHaveLength(20);
    expect(JSON.stringify(page)).not.toContain('secret');
  });

  it('rejects repository deletion while task preparation is active and deletes only finished history', async () => {
    const repos = new ReposService(db, {
      assertProjectIsActive: jest.fn().mockResolvedValue(undefined),
    } as never);
    db.update(schema.workspaces)
      .set({ taskState: 'preparing' })
      .where(eq(schema.workspaces.id, taskId))
      .run();
    await expect(
      repos.remove(repoId, { requireFinishedTasks: true }),
    ).rejects.toMatchObject({ response: { code: 'active_tasks', taskId } });
    expect(db.select().from(schema.repos).all()).toHaveLength(1);
    db.update(schema.workspaces)
      .set({ taskState: 'ready', archivedAt: '2026-10-13' })
      .where(eq(schema.workspaces.id, taskId))
      .run();
    await expect(
      repos.remove(repoId, { requireFinishedTasks: true }),
    ).resolves.toMatchObject({ id: repoId });
    expect(db.select().from(schema.repos).all()).toHaveLength(0);
  });

  it.each(['archive', 'delete'] as const)(
    'protects the caller in the actual folder %s membership snapshot',
    async (operation) => {
      const folder = db
        .insert(schema.sessionFolders)
        .values({ repoId, workspaceId: taskId, name: 'Target' })
        .returning()
        .get();
      const caller = session({ folderId: folder.id });
      const effect = jest.fn();
      const service = new SessionFoldersService(db, {
        archiveAndStop: effect,
        deleteMany: effect,
      } as never);
      await expect(
        service[operation](folder.id, caller.id),
      ).rejects.toMatchObject({
        response: { code: 'self_target_not_allowed' },
      });
      expect(effect).not.toHaveBeenCalled();
      expect(db.select().from(schema.sessions).all()).toHaveLength(1);
      expect(db.select().from(schema.sessionFolders).all()).toHaveLength(1);
    },
  );
});
