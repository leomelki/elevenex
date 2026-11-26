import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { createTestDb } from '../database/testing/create-test-db.js';
import * as schema from '../database/schema/index.js';
import {
  TaskAppHost,
  type AppLaunch,
  type AppRunObserver,
} from '../task-apps/task-app-host.js';
import type { TaskAppRun } from '@elevenex/shared';
import { ActionPtyManager } from './action-pty-manager.service.js';
import { ActionsService } from './actions.service.js';

jest.mock('node-pty', () => ({ spawn: jest.fn() }));

describe('saved Actions presented in Apps', () => {
  const command = 'pnpm run dev -- "argument with spaces"';
  const cwd = tmpdir();
  let store: ReturnType<typeof createTestDb>, id: number, taskId: number;
  let manager: ActionPtyManager, service: ActionsService;
  let launch: AppLaunch;

  beforeEach(async () => {
    store = createTestDb();
    const [project] = await store.db
      .insert(schema.projects)
      .values({ name: 'Preview' })
      .returning();
    const [repo] = await store.db
      .insert(schema.repos)
      .values({ name: 'App', projectId: project.id, path: cwd })
      .returning();
    const [task] = await store.db
      .insert(schema.workspaces)
      .values({ repoId: repo.id, name: 'Review', path: cwd })
      .returning();
    taskId = task.id;
    manager = new ActionPtyManager();
    service = new ActionsService(store.db, manager);
    const action = await service.create({
      name: 'Preview',
      command,
      worktreePath: cwd,
    });
    id = action.id;
    launch = {
      ...(await service.appCommand(taskId, cwd, id)),
      taskId,
      cwd,
      requestId: randomUUID(),
      mode: 'stream',
    };
  });
  afterEach(() => {
    manager.onModuleDestroy();
    store.sqlite.close();
  });

  it('preserves the command and exposes one lifecycle through Actions without launching a PTY', async () => {
    expect(launch.args.at(-1)).toBe(command);
    const run: TaskAppRun = {
      runId: randomUUID(),
      taskId,
      name: 'Preview',
      mode: 'stream',
      status: 'starting',
      startedAt: 1,
    };
    let events!: AppRunObserver;
    const start = jest.fn((observer: AppRunObserver) => {
      events = observer;
      return run;
    });
    const stop = jest.fn(() =>
      events.finished({ status: 'stopped', output: 'ready\n', exitCode: null }),
    );
    await service.runAppAction(launch, launch.savedAction!, start, stop);
    events.output('ready\n');
    expect(await service.findOne(id)).toMatchObject({
      status: 'running',
      currentOutput: 'ready\n',
    });
    expect(await service.listByWorktree(cwd)).toEqual([
      expect.objectContaining({ currentOutput: 'ready\n' }),
    ]);
    await expect(
      service.runAppAction(launch, launch.savedAction!, start, stop),
    ).rejects.toThrow('busy');
    await expect(service.run(id)).rejects.toThrow('already running');
    await expect(service.update(id, { command: 'different' })).rejects.toThrow(
      'Cannot edit',
    );
    expect(start).toHaveBeenCalledTimes(1);
    await service.stop(id);
    expect(stop).toHaveBeenCalledWith(run.runId);
    expect(await service.findOne(id)).toMatchObject({
      status: 'stopped',
      lastOutput: 'ready\n',
    });
    await expect(
      service.update(id, { command: 'different' }),
    ).resolves.toMatchObject({ command: 'different' });
  });

  const withDisplay =
    process.platform === 'linux' &&
    process.env.ELEVENEX_TEST_APP_DISPLAY === '1'
      ? it
      : it.skip;
  withDisplay(
    'settles a real private-display shell with identical exit status and output on both surfaces',
    async () => {
      await service.update(id, {
        command: 'printf "Action output\\n"; exit 7',
      });
      const spec = {
        ...launch,
        ...(await service.appCommand(taskId, cwd, id)),
      };
      const host = new TaskAppHost();
      try {
        const completed = new Promise<void>((resolve) => {
          service.on('action-status-changed', (event) => {
            if (event.status === 'failed') resolve();
          });
        });
        const app = await service.runAppAction(
          spec,
          spec.savedAction,
          (observer) => host.start(spec, observer),
          (runId) => host.stop(taskId, runId),
        );
        expect(host.count(taskId)).toBe(1);
        expect(host.count(taskId, true)).toBe(0);
        await completed;
        const action = await service.findOne(id);
        expect(action).toMatchObject({ status: 'failed', lastExitCode: 7 });
        expect(action.lastOutput).toContain('Action output');
        expect(host.get(taskId, app.runId).status).toBe('failed');
        expect(host.output(taskId, app.runId)).toBe(action.lastOutput);
      } finally {
        await host.onModuleDestroy();
      }
    },
    30_000,
  );

  it('revalidates proposal ownership and the saved command just before launch', async () => {
    await expect(service.appCommand(taskId + 1, cwd, id)).rejects.toThrow(
      'current task',
    );
    await expect(
      service.appCommand(taskId, cwd + '-other', id),
    ).rejects.toThrow('current task');
    await service.update(id, { command: 'new-command' });
    const start = jest.fn();
    await expect(
      service.runAppAction(launch, launch.savedAction!, start, jest.fn()),
    ).rejects.toThrow('Action changed');
    expect(start).not.toHaveBeenCalled();
    expect(await service.findOne(id)).toMatchObject({
      status: 'idle',
      lastRunAt: null,
    });
    await expect(service.remove(id)).resolves.toEqual({ success: true });
  });
});
