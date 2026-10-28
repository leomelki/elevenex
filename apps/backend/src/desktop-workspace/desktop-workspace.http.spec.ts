import { NavigationEventsService } from '../navigation/navigation-events.service.js';
import { eq, inArray } from 'drizzle-orm';
import * as schema from '../database/schema/index.js';
import { Test } from '@nestjs/testing';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '../database/testing/create-test-db.js';
import { DRIZZLE } from '../database/database.provider.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ReposService } from '../repos/repos.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { BranchesService } from '../branches/branches.service.js';
import { DesktopWorkspaceService } from './desktop-workspace.service.js';
import { DesktopWorkspaceController } from './desktop-workspace.controller.js';
import { DesktopWorkspaceGitService } from './desktop-workspace-git.service.js';
import { DesktopProjectDeletionService } from './desktop-project-deletion.service.js';

const execute = promisify(execFile);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected JSON object.');
  return value as Record<string, unknown>;
}
describe('desktop workspace HTTP resource slice', () => {
  let database: ReturnType<typeof createTestDb>;
  let app: INestApplication;
  let root: string;
  let firstRepo: string;
  let secondRepo: string;
  let url: string;
  const finishTask = jest.fn(async (id: number) => {
    await database.db
      .update(schema.workspaces)
      .set({ archivedAt: new Date().toISOString() })
      .where(eq(schema.workspaces.id, id));
  });
  const stopProjectSessions = jest
    .fn<Promise<void>, [number, boolean]>()
    .mockResolvedValue(undefined);
  const retryTask = jest.fn(async (id: number, _patch?: object) => {
    void _patch;
    await database.db
      .update(schema.workspaces)
      .set({ taskState: 'preparing', taskError: null })
      .where(eq(schema.workspaces.id, id));
  });
  const taskRecord = async (id: number) =>
    (
      await database.db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, id))
    )[0];
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'elevenex-workspace-http-'));
    firstRepo = join(root, 'first');
    secondRepo = join(root, 'second');
    await execute('git', ['init', '-b', 'main', firstRepo]);
    await execute('git', ['init', '-b', 'main', secondRepo]);
    database = createTestDb();
    const module = await Test.createTestingModule({
      controllers: [DesktopWorkspaceController],
      providers: [
        NavigationEventsService,
        DesktopWorkspaceService,
        DesktopProjectDeletionService,
        ProjectsService,
        ReposService,
        BranchesService,
        { provide: DRIZZLE, useValue: database.db },
        {
          provide: TasksService,
          useValue: {
            record: taskRecord,
            repo: async (id: number) =>
              (
                await database.db
                  .select()
                  .from(schema.repos)
                  .where(eq(schema.repos.id, id))
              )[0],
            retry: retryTask,
            finish: finishTask,
          },
        },
        { provide: DesktopWorkspaceGitService, useValue: {} },
        {
          provide: SessionsService,
          useValue: { archiveAllByProject: stopProjectSessions },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    database?.sqlite.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  const request = async (path: string, method = 'GET', body?: object) =>
    fetch(`${url}/api/desktop-workspace${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  it('checks names across active, archived and hidden projects without loading project pages', async () => {
    await database.db.insert(schema.projects).values([
      { name: 'Taken name & repo' },
      { name: 'Archived name', archivedAt: new Date().toISOString() },
      { name: 'Hidden name', hidden: true },
    ]);
    for (const name of ['Taken name & repo', 'Archived name', 'Hidden name', '  Archived name  ']) {
      const response = await request(`/projects/name-availability?name=${encodeURIComponent(name)}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ available: false });
    }
    expect(await (await request('/projects/name-availability?name=Unused')).json()).toEqual({ available: true });
    for (const name of ['', ' ', 'x'.repeat(101)])
      expect((await request(`/projects/name-availability?name=${encodeURIComponent(name)}`)).status).toBe(400);
    expect((await request('/projects/name-availability')).status).toBe(400);

    const untouched = join(root, 'duplicate-name-must-not-initialize');
    await mkdir(untouched);
    const rejected = await request('/projects', 'POST', {
      name: 'Archived name', path: untouched,
      repositorySetup: [{ path: untouched, initialize: true }],
    });
    expect(rejected.status).toBe(409);
    await expect(stat(join(untouched, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    await database.db.delete(schema.projects).where(inArray(schema.projects.name, ['Taken name & repo', 'Archived name', 'Hidden name']));
  });

  it('creates real repository resources, persists designed appearance/settings, and archives/restores/deletes project metadata', async () => {
    const before = object(await (await request('/revision')).json()).revision;
    const created = await request('/projects', 'POST', {
      name: 'Workspace',
      path: firstRepo,
      additionalPaths: [secondRepo],
      appearance: { look: 'emoji', emoji: '🦊', hue: 'pine' },
    });
    expect(created.status).toBe(201);
    const changed = object(await (await request('/revision')).json()).revision;
    expect(Number(changed)).toBeGreaterThan(Number(before));
    await request('/projects');
    expect(object(await (await request('/revision')).json()).revision).toBe(
      changed,
    );
    const body = object(await created.json());
    const project = object(body.project);
    const id = project.id;
    expect(typeof id).toBe('number');
    expect(project.appearance).toEqual({
      look: 'emoji',
      emoji: '🦊',
      hue: 'pine',
    });
    expect(object(body.repositories).items).toEqual([
      expect.objectContaining({ path: firstRepo, defaultBase: null }),
      expect.objectContaining({ path: secondRepo, defaultBase: null }),
    ]);
    expect(
      (
        await request(`/projects/${id}`, 'PATCH', {
          name: 'Renamed',
          agentInstructions: 'Run checks.',
        })
      ).status,
    ).toBe(200);
    const read = object(await (await request(`/projects/${id}`)).json());
    expect(object(read.project)).toMatchObject({
      name: 'Renamed',
      agentInstructions: 'Run checks.',
    });
    expect((await request(`/projects/${id}/archive`, 'POST')).status).toBe(201);
    expect(object(await (await request('/projects')).json()).items).toEqual([]);
    expect((await request(`/projects/${id}/restore`, 'POST')).status).toBe(201);
    expect(object(await (await request('/projects')).json()).items).toEqual([
      expect.objectContaining({ id }),
    ]);
    expect((await request(`/projects/${id}/delete`, 'POST')).status).toBe(201);
    expect((await request(`/projects/${id}`)).status).toBe(404);
    expect((await stat(join(firstRepo, '.git'))).isDirectory()).toBe(true);
  });
  it('creates a usable Git repository only for an explicit setup intent through HTTP', async () => {
    const path = join(root, 'new-folder');
    await mkdir(path);
    await writeFile(join(path, 'keep.txt'), 'uncommitted');
    const created = await request('/projects', 'POST', {
      name: 'Initialized',
      path,
      repositorySetup: [{ path, initialize: true }],
    });
    expect(created.status).toBe(201);
    expect(
      (
        await execute('git', ['rev-parse', '--verify', 'HEAD'], { cwd: path })
      ).stdout.trim(),
    ).toMatch(/^[a-f0-9]{40,64}$/);
    expect(
      (await execute('git', ['status', '--porcelain'], { cwd: path })).stdout,
    ).toContain('?? keep.txt');
    const id = object(object(await created.json()).project).id;
    await request(`/projects/${id}/delete`, 'POST');
    expect((await stat(join(path, '.git'))).isDirectory()).toBe(true);
  });
  it('closes open tasks and strictly stops project sessions before deleting metadata', async () => {
    const [project] = await database.db
      .insert(schema.projects)
      .values({ name: 'Delete with open tasks' })
      .returning();
    const [repo] = await database.db
      .insert(schema.repos)
      .values({ projectId: project.id, name: 'repo', path: firstRepo })
      .returning();
    const [task] = await database.db
      .insert(schema.workspaces)
      .values({ repoId: repo.id, name: 'Idle task', path: firstRepo })
      .returning();
    const revision = object(await (await request('/revision')).json()).revision;

    expect(
      (await request(`/projects/${project.id}/delete`, 'POST')).status,
    ).toBe(201);
    expect(finishTask).toHaveBeenCalledWith(task.id, true, undefined, {
      allowArchivedProject: true,
    });
    expect(stopProjectSessions).toHaveBeenCalledWith(project.id, true);
    expect(
      Number(object(await (await request('/revision')).json()).revision),
    ).toBeGreaterThan(Number(revision));
    expect((await request(`/projects/${project.id}`)).status).toBe(404);
    expect(await taskRecord(task.id)).toBeUndefined();
    expect((await stat(join(firstRepo, '.git'))).isDirectory()).toBe(true);
  });
  it('keeps the project when strict process cleanup fails and accepts an explicit retry', async () => {
    const [project] = await database.db
      .insert(schema.projects)
      .values({ name: 'Cleanup failure' })
      .returning();
    stopProjectSessions.mockRejectedValueOnce(
      new Error('Could not stop process'),
    );
    const rejected = await request(`/projects/${project.id}/delete`, 'POST');
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      code: 'project_cleanup_failed',
    });
    expect((await request(`/projects/${project.id}`)).status).toBe(200);
    expect(
      (await request(`/projects/${project.id}/delete`, 'POST')).status,
    ).toBe(201);
    expect((await request(`/projects/${project.id}`)).status).toBe(404);
  });
  it('returns structured setup failure and accepts only explicit supported recovery through HTTP', async () => {
    const [project] = await database.db
      .insert(schema.projects)
      .values({ name: 'Recovery' })
      .returning();
    const [repo] = await database.db
      .insert(schema.repos)
      .values({ projectId: project.id, name: 'repo', path: firstRepo })
      .returning();
    const error = JSON.stringify({
      code: 'external_checkout',
      path: '/existing/workspace',
      canSnapshot: true,
    });
    const [task] = await database.db
      .insert(schema.workspaces)
      .values({
        repoId: repo.id,
        name: 'Saved existing task',
        path: '',
        taskBranch: 'existing',
        taskState: 'failed',
        taskError: error,
      })
      .returning();
    const read = object(await (await request(`/tasks/${task.id}`)).json());
    expect(read.setupIssue).toMatchObject({
      code: 'external-checkout',
      workspacePath: '/existing/workspace',
      canUseSnapshot: true,
    });
    retryTask.mockClear();
    expect(
      (
        await request(`/tasks/${task.id}/retry`, 'POST', {
          confirmExternal: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`/tasks/${task.id}/retry`, 'POST', {
          recovery: 'arbitrary',
        })
      ).status,
    ).toBe(400);
    expect(retryTask).not.toHaveBeenCalled();
    const recovered = await request(`/tasks/${task.id}/retry`, 'POST', {
      recovery: 'use-existing',
    });
    expect(recovered.status).toBe(201);
    expect(object(await recovered.json())).toMatchObject({
      id: task.id,
      state: 'preparing',
    });
    expect(retryTask).toHaveBeenLastCalledWith(task.id, {
      confirmExternal: true,
    });
    await database.db
      .update(schema.workspaces)
      .set({ taskState: 'failed', taskError: error })
      .where(eq(schema.workspaces.id, task.id));
    expect(
      (
        await request(`/tasks/${task.id}/retry`, 'POST', {
          recovery: 'snapshot',
        })
      ).status,
    ).toBe(201);
    expect(retryTask).toHaveBeenLastCalledWith(task.id, {
      checkoutMode: 'snapshot',
      environment: 'automatic',
    });
    expect((await request(`/tasks/${task.id}/retry`, 'POST')).status).toBe(201);
    expect(retryTask).toHaveBeenLastCalledWith(task.id);
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
      .where(eq(schema.workspaces.id, task.id));
    const quotaFailure = object(
      await (await request(`/tasks/${task.id}`)).json(),
    );
    expect(quotaFailure.setupIssue).toMatchObject({
      canExceedWorktreeLimit: true,
      canUseSnapshot: false,
    });
    expect(
      (
        await request(`/tasks/${task.id}/retry`, 'POST', {
          recovery: 'exceed-worktree-limit',
        })
      ).status,
    ).toBe(201);
    expect(retryTask).toHaveBeenLastCalledWith(task.id, {
      confirmOverLimit: true,
    });
  });
  it('rejects malformed resource/page arguments and project appearance through the real HTTP boundary', async () => {
    expect((await request('/projects?limit=101')).status).toBe(400);
    expect((await request('/projects/-1')).status).toBe(400);
    expect(
      (
        await request('/projects', 'POST', {
          name: 'Invalid',
          path: firstRepo,
          appearance: { hue: 'pink' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request('/projects', 'POST', {
          name: 'Invalid path',
          path: '/missing-repository',
        })
      ).status,
    ).toBe(400);
  });
});
