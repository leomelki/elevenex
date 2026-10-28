import { resolve, basename } from 'node:path';
import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../database/testing/create-test-db.js';
import { DRIZZLE } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ReposService } from '../repos/repos.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { BranchesService } from '../branches/branches.service.js';
import { DesktopWorkspaceActivityService } from './desktop-workspace-activity.service.js';
import { DesktopWorkspaceService } from './desktop-workspace.service.js';

describe('DesktopWorkspaceService', () => {
  let database: ReturnType<typeof createTestDb>;
  let service: DesktopWorkspaceService;
  let projectId: number;
  let repoId: number;
  let taskId: number;
  const retryTask = jest.fn();
  const activityStatus = jest.fn<string | undefined, []>();
  const archiveSession = jest.fn();
  const restoreSession = jest.fn();
  beforeEach(async () => {
    activityStatus.mockReset();
    archiveSession.mockReset(); restoreSession.mockReset();
    archiveSession.mockImplementation(async (id: number) => {
      await database.db.update(schema.sessions).set({status: 'archived'}).where(eq(schema.sessions.id, id));
    });
    restoreSession.mockImplementation(async (id: number) => {
      return (await database.db.update(schema.sessions).set({status: 'stopped'}).where(eq(schema.sessions.id, id)).returning())[0];
    });
    retryTask.mockReset();
    retryTask.mockResolvedValue(undefined);
    database = createTestDb();
    const db = database.db;
    projectId = (
      await db.insert(schema.projects).values({ name: 'Visible' }).returning()
    )[0].id;
    repoId = (
      await db
        .insert(schema.repos)
        .values({ projectId, name: 'repo', path: '/repo' })
        .returning()
    )[0].id;
    taskId = (
      await db
        .insert(schema.workspaces)
        .values({
          repoId,
          name: 'Build',
          path: '/repo/task',
          taskBranch: 'build',
        })
        .returning()
    )[0].id;
    const module = await Test.createTestingModule({
      providers: [
        DesktopWorkspaceService,
        { provide: DesktopWorkspaceActivityService, useValue: {status: activityStatus} },
        ProjectsService,
        { provide: DRIZZLE, useValue: db },
        {
          provide: ReposService,
          useValue: {
            validatePath: jest.fn(async (path: string) => ({
              name: basename(path),
              path: resolve(path),
            })),
            addRepo: (id: number, path: string) =>
              db
                .insert(schema.repos)
                .values({ projectId: id, name: 'new', path })
                .returning()
                .then((rows) => rows[0]),
          },
        },
        {
          provide: TasksService,
          useValue: {
            retry: retryTask,
            record: (id: number) =>
              db
                .select()
                .from(schema.workspaces)
                .where(eq(schema.workspaces.id, id))
                .then((rows) => rows[0]),
            repo: (id: number) =>
              db
                .select()
                .from(schema.repos)
                .where(eq(schema.repos.id, id))
                .then((rows) => rows[0]),
          },
        },
        {
          provide: SessionsService,
          useValue: {
            archiveAllByProject: jest.fn().mockResolvedValue(undefined),
            archiveAndStop: archiveSession,
            unarchive: restoreSession,
          },
        },
        { provide: BranchesService, useValue: {} },
      ],
    }).compile();
    service = module.get(DesktopWorkspaceService);
  });
  afterEach(() => database?.sqlite.close());

  it('archives only task-owned conversations, preserves their data and marks them for task reopen', async () => {
    await database.db.update(schema.workspaces).set({taskState:'ready'}).where(eq(schema.workspaces.id,taskId));
    const [session] = await database.db.insert(schema.sessions).values({repoId, workspaceId:taskId, branchName:'build', worktreePath:'/repo/task', name:'Keep history', status:'stopped'}).returning();
    await expect(service.archiveSession(taskId,session.id,'yes')).rejects.toThrow(BadRequestException);
    await expect(service.archiveSession(taskId,session.id + 1,true)).rejects.toThrow('does not belong');
    expect(archiveSession).not.toHaveBeenCalled();
    await service.archiveSession(taskId,session.id,false);
    expect(archiveSession).toHaveBeenCalledWith(session.id,true);
    const [archived] = await database.db.select().from(schema.sessions).where(eq(schema.sessions.id,session.id));
    expect(archived.name).toBe('Keep history'); expect(archived.status).toBe('archived'); expect(archived.archivedByTask).toBe(true);
    expect((await service.listSessions(taskId,{})).items).toHaveLength(0);
    const restored = await service.restoreSession(taskId,session.id);
    expect(restored.id).toBe(session.id); expect(restored.status).toBe('done');
    expect(restoreSession).toHaveBeenCalledWith(session.id);
    const [row] = await database.db.select().from(schema.sessions).where(eq(schema.sessions.id,session.id));
    expect(row.archivedByTask).toBe(false);
    await database.db.update(schema.workspaces).set({archivedAt:'now'}).where(eq(schema.workspaces.id,taskId));
    await expect(service.archiveSession(taskId,session.id,true)).rejects.toThrow('not ready');
  });

  it('requires authoritative running confirmation and reports cleanup failures', async () => {
    const [session] = await database.db.insert(schema.sessions).values({repoId, workspaceId:taskId, branchName:'build', worktreePath:'/repo/task', name:'Running'}).returning();
    activityStatus.mockReturnValue('running');
    await expect(service.archiveSession(taskId,session.id,false)).rejects.toThrow('Stop and archive');
    expect(archiveSession).not.toHaveBeenCalled();
    archiveSession.mockRejectedValueOnce(new Error('Cleanup failed'));
    await expect(service.archiveSession(taskId,session.id,true)).rejects.toThrow('Cleanup failed');
    expect(archiveSession).toHaveBeenCalledWith(session.id,true);
    const [row] = await database.db.select().from(schema.sessions).where(eq(schema.sessions.id,session.id));
    expect(row.archivedByTask).toBe(false);
  });

  it('bounds project pages, excludes hidden/archived projects, and validates cursors', async () => {
    await database.db
      .insert(schema.projects)
      .values([
        { name: 'Hidden', hidden: true },
        { name: 'Archived', archivedAt: '2026-01-01' },
        { name: 'Next' },
        { name: 'Last' },
      ]);
    const first = await service.listProjects({ limit: '1' });
    expect(first.items.map((project) => project.name)).toEqual(['Visible']);
    expect(first.nextCursor).toBe(String(projectId));
    const next = await service.listProjects({
      limit: '1',
      cursor: first.nextCursor!,
    });
    expect(next.items.map((project) => project.name)).toEqual(['Next']);
    expect(
      await service.listProjects({ limit: '100', cursor: next.nextCursor! }),
    ).toMatchObject({ items: [{ name: 'Last' }], nextCursor: null });
    await expect(service.listProjects({ limit: '101' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.listProjects({ cursor: '-1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
  it('persists presentation stages without changing legacy lifecycle and excludes default workspaces', async () => {
    await database.db.insert(schema.workspaces).values({
      repoId,
      name: 'Default workspace',
      path: '/repo',
      isDefault: true,
    });
    await service.setStage(taskId, 'waiting');
    expect(
      (await service.listTasks({ projectId: String(projectId) })).items,
    ).toEqual([
      expect.objectContaining({ id: taskId, stage: 'waiting', state: 'ready' }),
    ]);
    expect(
      (
        await database.db
          .select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, taskId))
      )[0].taskState,
    ).toBe('ready');
    await expect(service.setStage(taskId, 'nonsense')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
  it('reports project repository cardinality even when only one repository has tasks in the page', async () => {
    expect(
      (await service.listTasks({ limit: '1' })).items[0].projectRepositoryCount,
    ).toBe(1);
    expect((await service.task(taskId)).projectRepositoryCount).toBe(1);
    await database.db
      .insert(schema.repos)
      .values({ projectId, name: 'second', path: '/second' });
    expect(
      (await service.listTasks({ limit: '1' })).items[0].projectRepositoryCount,
    ).toBe(2);
    expect((await service.task(taskId)).projectRepositoryCount).toBe(2);
  });

  it('adds newest-first keyset windows while preserving chronological display and legacy ordering', async () => {
    await database.db.insert(schema.sessions).values(Array.from({length:25},(_,index)=>({repoId,workspaceId:taskId,name:`Session ${index}`,branchName:'build',worktreePath:'/repo/task'})));
    const legacy = await service.listSessions(taskId,{limit:'5'});
    expect(legacy.items.map(session=>session.name)).toEqual(['Session 0','Session 1','Session 2','Session 3','Session 4']);
    const latest = await service.listSessions(taskId,{limit:'5',order:'latest'});
    expect(latest.items.map(session=>session.name)).toEqual(['Session 20','Session 21','Session 22','Session 23','Session 24']);
    const earlier = await service.listSessions(taskId,{limit:'5',order:'latest',cursor:latest.nextCursor!});
    expect(earlier.items.map(session=>session.name)).toEqual(['Session 15','Session 16','Session 17','Session 18','Session 19']);
    await expect(service.listSessions(taskId,{order:'random'})).rejects.toThrow('Invalid session order');
  });

  it('returns bounded session summaries without private tokens and excludes archived sessions', async () => {
    await database.db.insert(schema.sessions).values([
      {
        repoId,
        workspaceId: taskId,
        name: 'First',
        branchName: 'build',
        worktreePath: '/repo/task',
        mcpAgentToken: 'private-token',
      },
      {
        repoId,
        workspaceId: taskId,
        name: 'Second',
        branchName: 'build',
        worktreePath: '/repo/task',
      },
      {
        repoId,
        workspaceId: taskId,
        name: 'Archived',
        branchName: 'build',
        worktreePath: '/repo/task',
        status: 'archived',
      },
    ]);
    const first = await service.listSessions(taskId, { limit: '1' });
    expect(first.items).toHaveLength(1);
    expect(JSON.stringify(first)).not.toContain('private-token');
    expect(Object.keys(first.items[0]).sort()).toEqual([
      'id',
      'name',
      'provider',
      'repoId',
      'status',
      'taskId',
      'updatedAt',
    ]);
    expect(
      (
        await service.listSessions(taskId, { cursor: first.nextCursor! })
      ).items.map((session) => session.name),
    ).toEqual(['Second']);
  });
  it('persists project name, appearance and instructions and validates the supported token vocabulary', async () => {
    await service.updateProject(projectId, {
      name: 'Renamed',
      appearance: { look: 'emoji', emoji: '🦊', hue: 'pine' },
      agentInstructions: 'Run checks.',
    });
    expect((await service.project(projectId)).project).toEqual({
      id: projectId,
      name: 'Renamed',
      agentInstructions: 'Run checks.',
      appearance: { look: 'emoji', emoji: '🦊', hue: 'pine' },
    });
    await expect(
      service.updateProject(projectId, { appearance: { hue: 'pink' } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps archived conversation history navigable for closed tasks', async () => {
    await database.db.insert(schema.sessions).values({
      repoId,
      workspaceId: taskId,
      name: 'History',
      branchName: 'build',
      worktreePath: '/repo/task',
      status: 'archived',
      archivedByTask: true,
    });
    expect((await service.listSessions(taskId, {})).items).toEqual([]);
    await database.db
      .update(schema.workspaces)
      .set({ archivedAt: new Date().toISOString() })
      .where(eq(schema.workspaces.id, taskId));
    expect((await service.listSessions(taskId, { limit: '1' })).items).toEqual([
      expect.objectContaining({ name: 'History', status: 'archived' }),
    ]);
  });
  it('pages archived sessions independently and keeps completed sessions normal', async () => {
    const rows = await database.db.insert(schema.sessions).values([
      { repoId, workspaceId: taskId, branchName: 'build', worktreePath: '/repo/task', name: 'Stopped', status: 'stopped' },
      { repoId, workspaceId: taskId, branchName: 'build', worktreePath: '/repo/task', name: 'Archived first', status: 'archived' },
      { repoId, workspaceId: taskId, branchName: 'build', worktreePath: '/repo/task', name: 'Archived second', status: 'archived' },
      { repoId, workspaceId: taskId, branchName: 'build', worktreePath: '/repo/task', name: 'Hidden auxiliary', surface: 'git-job', status: 'archived' },
    ]).returning();
    const normal = await service.listSessions(taskId, { state: 'normal' });
    expect(normal.items.map(row => row.name)).toEqual(['Stopped']);
    const latest = await service.listSessions(taskId, { state: 'archived', order: 'latest', limit: '1' });
    expect(latest.items.map(row => row.name)).toEqual(['Archived second']);
    const earlier = await service.listSessions(taskId, { state: 'archived', order: 'latest', limit: '1', cursor: latest.nextCursor! });
    expect(earlier.items.map(row => row.name)).toEqual(['Archived first']);
    expect(earlier.nextCursor).toBeNull();
    await database.db.update(schema.sessions).set({ status: 'stopped' }).where(eq(schema.sessions.id, rows[1].id));
    expect((await service.listSessions(taskId, { state: 'archived' })).items.map(row => row.name)).toEqual(['Archived second']);
    await expect(service.listSessions(taskId, { state: 'all' })).rejects.toThrow('Invalid session state');
    await expect(service.listSessions(taskId, { state: 'archived', limit: '101' })).rejects.toThrow('Page limit');
  });

  it('rejects duplicate normalized paths before creating any durable project or repository', async () => {
    await expect(
      service.createProject({
        name: 'Canonical duplicate',
        path: '/repo',
        additionalPaths: ['/repo/'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(
      (await database.db.select().from(schema.projects)).map(
        (project) => project.name,
      ),
    ).toEqual(['Visible']);
    expect(
      (await database.db.select().from(schema.repos)).map((repo) => repo.path),
    ).toEqual(['/repo']);
  });

  it('creates all selected repositories and project appearance', async () => {
    const created = await service.createProject({
      name: 'Multi',
      path: '/one',
      additionalPaths: ['/two'],
      appearance: { look: 'letters', hue: 'ocean' },
    });
    expect(created.repositories.items.map((repo) => repo.path)).toEqual([
      '/one',
      '/two',
    ]);
    expect(created.project.appearance).toEqual({
      look: 'letters',
      hue: 'ocean',
    });
    await expect(
      service.createProject({
        name: 'Duplicate',
        path: '/one',
        additionalPaths: ['/one'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('returns a bounded setup issue for saved failed tasks instead of hiding the cause', async () => {
    await database.db
      .update(schema.workspaces)
      .set({
        taskState: 'failed',
        taskError: JSON.stringify({
          code: 'external_checkout',
          path: '/work/existing',
          canSnapshot: true,
          secret: 'private',
        }),
      })
      .where(eq(schema.workspaces.id, taskId));
    const task = await service.task(taskId);
    expect(task.setupIssue).toMatchObject({
      code: 'external-checkout',
      workspacePath: '/work/existing',
      canUseSnapshot: true,
    });
    expect(JSON.stringify(task)).not.toContain('private');
    expect((await service.listTasks({})).items[0].setupIssue).toEqual(
      task.setupIssue,
    );
  });
  it('preserves default retries and validates explicit recovery against durable task state', async () => {
    await service.retryTask(taskId);
    expect(retryTask).toHaveBeenLastCalledWith(taskId);
    await database.db
      .update(schema.workspaces)
      .set({
        taskState: 'failed',
        taskError: JSON.stringify({
          code: 'external_checkout',
          canSnapshot: true,
        }),
      })
      .where(eq(schema.workspaces.id, taskId));
    await service.retryTask(taskId, { recovery: 'use-existing' });
    expect(retryTask).toHaveBeenLastCalledWith(taskId, {
      confirmExternal: true,
    });
    await service.retryTask(taskId, { recovery: 'snapshot' });
    expect(retryTask).toHaveBeenLastCalledWith(taskId, {
      checkoutMode: 'snapshot',
      environment: 'automatic',
    });
    await database.db
      .update(schema.workspaces)
      .set({
        taskState: 'failed',
        taskError: JSON.stringify({
          code: 'environment_busy',
          canSnapshot: true,
        }),
      })
      .where(eq(schema.workspaces.id, taskId));
    retryTask.mockClear();
    await expect(
      service.retryTask(taskId, { recovery: 'use-existing' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.retryTask(taskId, { recovery: 'arbitrary' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.retryTask(taskId, { confirmExternal: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.retryTask(taskId, { recovery: 'exceed-worktree-limit' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await database.db
      .update(schema.workspaces)
      .set({ taskState: 'ready', taskError: null })
      .where(eq(schema.workspaces.id, taskId));
    await expect(
      service.retryTask(taskId, { recovery: 'snapshot' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(retryTask).not.toHaveBeenCalled();
  });
  it('allows quota consent only for a saved quota failure and keeps the same task', async () => {
    await database.db
      .update(schema.workspaces)
      .set({
        taskState: 'failed',
        taskError: JSON.stringify({
          code: 'worktree_limit_reached',
          count: 23,
          limit: 5,
        }),
      })
      .where(eq(schema.workspaces.id, taskId));
    expect((await service.task(taskId)).setupIssue).toMatchObject({
      canExceedWorktreeLimit: true,
    });
    await expect(
      service.retryTask(taskId, { confirmOverLimit: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await service.retryTask(taskId, { recovery: 'exceed-worktree-limit' });
    expect(retryTask).toHaveBeenLastCalledWith(taskId, {
      confirmOverLimit: true,
    });
    retryTask.mockClear();
    await database.db
      .update(schema.workspaces)
      .set({ taskState: 'ready' })
      .where(eq(schema.workspaces.id, taskId));
    await expect(
      service.retryTask(taskId, { recovery: 'exceed-worktree-limit' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(retryTask).not.toHaveBeenCalled();
  });
});
