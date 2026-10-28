import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { createTestDb } from '../database/testing/create-test-db.js';
import { ProjectsService } from '../projects/projects.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { DesktopProjectDeletionService } from './desktop-project-deletion.service.js';

describe('confirmed desktop project deletion', () => {
  let database: ReturnType<typeof createTestDb>;
  let service: DesktopProjectDeletionService;
  let projectId: number;
  let repoId: number;
  const finish = jest.fn<Promise<void>, [number, boolean, unknown, object]>();
  const stopSessions = jest.fn<Promise<void>, [number, boolean]>();

  beforeEach(async () => {
    database = createTestDb();
    finish.mockReset();
    finish.mockImplementation(async (id) => {
      await database.db
        .update(schema.workspaces)
        .set({ archivedAt: new Date().toISOString() })
        .where(eq(schema.workspaces.id, id));
    });
    stopSessions.mockReset();
    stopSessions.mockResolvedValue(undefined);
    const module = await Test.createTestingModule({
      providers: [
        DesktopProjectDeletionService,
        ProjectsService,
        { provide: DRIZZLE, useValue: database.db },
        { provide: TasksService, useValue: { finish } },
        {
          provide: SessionsService,
          useValue: { archiveAllByProject: stopSessions },
        },
      ],
    }).compile();
    service = module.get(DesktopProjectDeletionService);
    const [project] = await database.db
      .insert(schema.projects)
      .values({ name: 'Delete' })
      .returning();
    projectId = project.id;
    const [repo] = await database.db
      .insert(schema.repos)
      .values({ projectId, name: 'repo', path: '/repo' })
      .returning();
    repoId = repo.id;
  });
  afterEach(() => database.sqlite.close());

  const addTask = async (state = 'ready', repositoryId = repoId) =>
    (
      await database.db
        .insert(schema.workspaces)
        .values({
          repoId: repositoryId,
          name: 'Task',
          path: '/task',
          taskState: state,
        })
        .returning()
    )[0];
  const projectExists = async () =>
    (
      await database.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, projectId))
    ).length === 1;

  it('finishes bounded pages across repositories, including preparing, failed and released tasks, before the cascade', async () => {
    const [secondRepo] = await database.db
      .insert(schema.repos)
      .values({ projectId, name: 'second', path: '/second' })
      .returning();
    const tasks = await database.db
      .insert(schema.workspaces)
      .values(
        Array.from({ length: 53 }, (_, index) => ({
          repoId: index % 2 ? secondRepo.id : repoId,
          name: `Task ${index}`,
          path: '/task',
          taskState: ['ready', 'preparing', 'failed', 'released'][index % 4],
        })),
      )
      .returning();
    await database.db.insert(schema.workspaces).values([
      {
        repoId,
        name: 'Already closed',
        path: '/closed',
        archivedAt: '2026-10-01',
      },
      { repoId, name: 'Default', path: '/repo', isDefault: true },
    ]);
    const [other] = await database.db
      .insert(schema.projects)
      .values({ name: 'Other' })
      .returning();
    const [otherRepo] = await database.db
      .insert(schema.repos)
      .values({ projectId: other.id, name: 'other', path: '/other' })
      .returning();
    const otherTask = await addTask('ready', otherRepo.id);
    await database.db.insert(schema.sessions).values({
      repoId,
      branchName: 'main',
      worktreePath: '/repo',
      name: 'Legacy session',
      status: 'running',
    });
    stopSessions.mockImplementation(async (id, strict) => {
      expect(id).toBe(projectId);
      expect(strict).toBe(true);
      expect(await projectExists()).toBe(true);
      expect(finish).toHaveBeenCalledTimes(tasks.length);
    });

    await service.delete(projectId);
    expect(finish.mock.calls.map(([id]) => id)).toEqual(
      tasks.map((task) => task.id),
    );
    for (const [id] of finish.mock.calls)
      expect(finish).toHaveBeenCalledWith(id, true, undefined, {
        allowArchivedProject: true,
      });
    expect(await projectExists()).toBe(false);
    expect(await database.db.select().from(schema.sessions)).toHaveLength(0);
    expect(await database.db.select().from(schema.workspaces)).toEqual([
      otherTask,
    ]);
  });

  it('coalesces concurrent deletion of the same project while awaiting cleanup', async () => {
    await addTask();
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    stopSessions.mockReturnValueOnce(cleanup);
    const first = service.delete(projectId);
    const second = service.delete(projectId);
    expect(first).toBe(second);
    release();
    await Promise.all([first, second]);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(stopSessions).toHaveBeenCalledTimes(1);
  });

  it('retains project and task records after task shutdown fails, then retries unfinished cleanup', async () => {
    const first = await addTask();
    const second = await addTask();
    const close = finish.getMockImplementation()!;
    finish
      .mockImplementationOnce(close)
      .mockRejectedValueOnce(new Error('Agent still running'));
    await expect(service.delete(projectId)).rejects.toMatchObject({
      response: { code: 'project_cleanup_failed' },
    });
    expect(await projectExists()).toBe(true);
    expect(await database.db.select().from(schema.workspaces)).toHaveLength(2);
    expect(stopSessions).not.toHaveBeenCalled();
    await service.delete(projectId);
    expect(finish.mock.calls.map(([id]) => id)).toEqual([
      first.id,
      second.id,
      second.id,
    ]);
    expect(await projectExists()).toBe(false);
  });

  it('keeps metadata when legacy session cleanup fails, including in an archived project', async () => {
    await addTask();
    await database.db
      .update(schema.projects)
      .set({ archivedAt: '2026-10-01' })
      .where(eq(schema.projects.id, projectId));
    stopSessions.mockRejectedValueOnce(new Error('Terminal still running'));
    await expect(service.delete(projectId)).rejects.toMatchObject({
      response: { code: 'project_cleanup_failed' },
    });
    expect(await projectExists()).toBe(true);
    await service.delete(projectId);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(await projectExists()).toBe(false);
  });

  it('keeps the transactional guard when another window opens a task during final cleanup', async () => {
    await addTask();
    stopSessions.mockImplementationOnce(async () => {
      await addTask();
    });
    await expect(service.delete(projectId)).rejects.toMatchObject({
      response: { code: 'active_tasks' },
    });
    expect(await projectExists()).toBe(true);
    await service.delete(projectId);
    expect(await projectExists()).toBe(false);
  });

  it('rejects missing projects before attempting process cleanup', async () => {
    await expect(service.delete(projectId + 1)).rejects.toMatchObject({
      status: 404,
    });
    expect(finish).not.toHaveBeenCalled();
    expect(stopSessions).not.toHaveBeenCalled();
  });
});
