import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TaskAppRun } from '@elevenex/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../database/schema/index.js';
import type { AppLaunch } from './app-launch.js';
import { linuxSupervisor } from './linux-supervisor.js';
import { supervisorBirth } from './supervisor-identity.js';
import { TaskAppHost } from './task-app-host.js';
import { appRunDirectory, TaskAppJournal } from './task-app-journal.js';

async function database(directory: string) {
  const sqlite = new Database(join(directory, 'apps.db'));
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve(__dirname, '../../drizzle') });
  const existing = db.select().from(schema.workspaces).get();
  let taskId = existing?.id;
  if (!taskId) {
    const project = db
      .insert(schema.projects)
      .values({ name: 'Fixture' })
      .returning()
      .get();
    const repo = db
      .insert(schema.repos)
      .values({ projectId: project.id, name: 'Repo', path: directory })
      .returning()
      .get();
    taskId = db
      .insert(schema.workspaces)
      .values({ repoId: repo.id, name: 'Task', path: directory })
      .returning()
      .get().id;
  }
  return { sqlite, db, taskId, journal: new TaskAppJournal(db) };
}

function launch(taskId: number, cwd: string): AppLaunch {
  return {
    taskId,
    cwd,
    requestId: randomUUID(),
    mode: 'native',
    executable: process.execPath,
    name: 'Private project name',
    args: ['-e', "console.log('private argument')"],
  };
}

function starting(request: AppLaunch): TaskAppRun {
  return {
    taskId: request.taskId,
    runId: randomUUID(),
    name: request.name,
    mode: request.mode,
    status: 'starting',
    startedAt: Date.now(),
  };
}

async function waitFor(predicate: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error('The app supervisor did not reach the expected state.');
}

describe('durable task app requests', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ex-app-journal-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('expires pending consent and preserves a scoped receipt when the database reopens', async () => {
    let store = await database(directory);
    const request = launch(store.taskId, directory);
    const pending = { ...starting(request), status: 'requested' as const };
    store.journal.reserve(request, pending);
    store.sqlite.close();

    store = await database(directory);
    const host = new TaskAppHost(undefined, store.journal);
    try {
      const receipt = await host.start(request);
      expect(receipt).toMatchObject({ runId: pending.runId, status: 'exited' });
      expect(host.get(store.taskId, pending.runId)).toEqual(receipt);
      expect(host.list(store.taskId)).toEqual([receipt]);
      expect(host.count(store.taskId)).toBe(0);
      expect(() => host.approve(store.taskId, pending.runId)).toThrow();
      expect(() => host.get(store.taskId + 1, pending.runId)).toThrow();
      await expect(
        host.start({ ...request, executable: 'changed' }),
      ).rejects.toThrow('reused');
      const record = JSON.stringify(
        store.db.select().from(schema.taskAppJournal).all(),
      );
      for (const value of [
        request.name,
        request.executable,
        request.args[1],
        request.requestId,
        directory,
      ]) {
        expect(record).not.toContain(value);
      }
    } finally {
      await host.onModuleDestroy();
      store.sqlite.close();
    }
  });

  it('reclaims an ungranted launch after restart and preserves its ID', async () => {
    let store = await database(directory);
    const request = launch(store.taskId, directory);
    const state = starting(request);
    store.journal.reserve(request, state);
    const scratch = appRunDirectory(state.runId);
    await mkdir(scratch, { mode: 0o700 });
    await writeFile(join(scratch, 'scratch'), 'private run file');
    store.sqlite.close();

    store = await database(directory);
    const host = new TaskAppHost(undefined, store.journal);
    try {
      await host.stopAll(store.taskId);
      const receipt = await host.start(request);
      expect(receipt).toMatchObject({ runId: state.runId, status: 'exited' });
      expect(host.count(store.taskId)).toBe(0);
      await expect(access(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await host.onModuleDestroy();
      store.sqlite.close();
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('deduplicates completed requests even after in-memory history was evicted', async () => {
    const store = await database(directory);
    const host = new TaskAppHost(undefined, store.journal);
    try {
      const request = launch(store.taskId, directory);
      const state = starting(request);
      store.journal.reserve(request, state);
      store.journal.finish(state.runId, 'exited');
      for (let i = 0; i < 140; i++) {
        const next = launch(store.taskId, directory);
        const pending = host.propose(next, {
          sessionId: 1,
          checkoutToken: 'generation',
        });
        await host.stop(store.taskId, pending.runId);
      }
      const receipt = await host.start(request);
      expect(receipt).toMatchObject({ runId: state.runId, status: 'exited' });
      expect(host.list(store.taskId)).toHaveLength(128);
      expect(host.beginRuntimeHandoff()).toBe(0);
    } finally {
      await host.onModuleDestroy();
      store.sqlite.close();
    }
  });

  const linux = process.platform === 'linux' ? it : it.skip;
  linux(
    'runs an admitted executable once and reconciles its terminal receipt through a replacement host',
    async () => {
      let store = await database(directory);
      let host = new TaskAppHost(undefined, store.journal);
      const request = launch(store.taskId, directory);
      const marker = join(directory, 'native-starts');
      request.args = [
        '-e',
        "const fs = require('node:fs'); fs.appendFileSync(process.argv[1], 'started'); fs.writeSync(1, 'fixture output\\n');",
        marker,
      ];
      const display = process.env.DISPLAY;
      // Native launch can exercise the supervisor without a graphical client.
      process.env.DISPLAY ??= ':unused';
      try {
        const first = await host.start(request);
        await waitFor(async () => {
          const run = host.get(store.taskId, first.runId);
          if (run.status === 'failed') throw new Error(run.detail);
          return run.status === 'exited';
        });
        expect(host.output(store.taskId, first.runId)).toContain(
          'fixture output',
        );
        await host.onModuleDestroy();
        store.sqlite.close();
        store = await database(directory);
        host = new TaskAppHost(undefined, store.journal);
        const receipt = await host.start(request);
        expect(receipt).toMatchObject({ runId: first.runId, status: 'exited' });
        expect(await readFile(marker, 'utf8')).toBe('started');
        expect(host.output(store.taskId, first.runId)).not.toContain(
          'fixture output',
        );
      } finally {
        if (display === undefined) delete process.env.DISPLAY;
        else process.env.DISPLAY = display;
        await host.onModuleDestroy();
        store.sqlite.close();
      }
    },
    25_000,
  );

  linux(
    'keeps a checkout reserved if its POSIX supervisor disappeared before acknowledging the drain',
    async () => {
      let store = await database(directory);
      const request = launch(store.taskId, directory);
      const state = starting(request);
      const scratch = appRunDirectory(state.runId);
      await mkdir(scratch, { mode: 0o700 });
      const supervisor = spawn(
        '/usr/bin/python3',
        ['-I', '-u', '-c', linuxSupervisor],
        {
          stdio: ['pipe', 'ignore', 'ignore', 'pipe'],
          env: {
            ...process.env,
            ELEVENEX_TASK_APP_RUNTIME_DIR: scratch,
            ELEVENEX_TASK_APP_DRAIN_PROOF: '1',
          },
        },
      );
      const closed = once(supervisor, 'exit');
      try {
        store.journal.reserve(request, state);
        await once(supervisor, 'spawn');
        await store.journal.grant(state.runId, supervisor.pid!);
        const ready = once(supervisor.stdio[3]!, 'data');
        supervisor.stdin!.write(
          JSON.stringify({
            mode: 'native',
            executable: process.execPath,
            args: ['-e', 'setTimeout(()=>{}, 200)'],
          }) + '\n',
        );
        const [reply] = await ready;
        expect(JSON.parse(reply.toString()).kind).toBe('ready');
        supervisor.kill('SIGKILL');
        await closed;
        await expect(store.journal.readyToClean(state.runId)).rejects.toThrow(
          'restart the task machine',
        );
        store.sqlite.close();
        store = await database(directory);
        const host = new TaskAppHost(undefined, store.journal);
        expect(host.count(store.taskId)).toBe(1);
        expect((await host.start(request)).status).toBe('stopping');
        // Simulate the same durable receipt from a previous OS boot. That boot's
        // process tree is gone even though no final supervisor write was possible.
        store.db
          .update(schema.taskAppJournal)
          .set({ supervisorBirth: 'linux:' + randomUUID() + ':1' })
          .where(eq(schema.taskAppJournal.runId, state.runId))
          .run();
        const rebooted = new TaskAppHost(
          undefined,
          new TaskAppJournal(store.db),
        );
        await rebooted.stopAll(store.taskId);
        expect(rebooted.count(store.taskId)).toBe(0);
        expect(rebooted.get(store.taskId, state.runId).status).toBe('failed');
      } finally {
        if (supervisor.exitCode === null && supervisor.signalCode === null)
          supervisor.kill('SIGKILL');
        await closed;
        store.sqlite.close();
        await rm(scratch, { recursive: true, force: true });
      }
    },
    15_000,
  );

  linux(
    'holds a live supervisor through owner loss, then reclaims the run without replaying it',
    async () => {
      let store = await database(directory);
      const request = launch(store.taskId, directory);
      const state = starting(request);
      const scratch = appRunDirectory(state.runId);
      const starts = join(directory, 'started');
      await mkdir(scratch, { mode: 0o700 });
      // A distinct process owns the supervisor's stdin, as the engine would. Its
      // abrupt termination delivers EOF independently of every Node cleanup hook.
      const owner = spawn(
        process.execPath,
        [
          '-e',
          `
      const { spawn } = require('node:child_process');
      const supervisor = spawn('/usr/bin/python3', ['-I', '-u', '-c', process.env.TEST_SUPERVISOR], {
        stdio: ['pipe', 'ignore', 'inherit', 'pipe'], detached: true,
      });
      supervisor.stdio[3].pipe(process.stderr);
      supervisor.once('spawn', () => process.send({ pid: supervisor.pid }));
      process.once('message', command => supervisor.stdin.write(JSON.stringify(command) + '\\n'));
    `,
        ],
        {
          env: {
            ...process.env,
            TEST_SUPERVISOR: linuxSupervisor,
            ELEVENEX_TASK_APP_RUNTIME_DIR: scratch,
            ELEVENEX_TASK_APP_DRAIN_PROOF: '1',
          },
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        },
      );
      let diagnostics = '';
      owner.stderr?.setEncoding('utf8').on('data', (text) => {
        diagnostics = (diagnostics + text).slice(-1024);
      });
      const ownerClosed = once(owner, 'exit');
      let host: TaskAppHost | undefined;
      try {
        store.journal.reserve(request, state);
        const [{ pid }] = await once(owner, 'message');
        await store.journal.grant(state.runId, pid);
        owner.send({
          mode: 'native',
          executable: process.execPath,
          args: [
            '-e',
            "require('node:fs').appendFileSync(process.argv[1], process.pid+'\\n');setInterval(()=>{}, 1000)",
            starts,
          ],
        });
        await waitFor(async () => {
          if (owner.exitCode !== null || /"kind": "error"/.test(diagnostics))
            throw new Error(diagnostics);
          return !!(await readFile(starts, 'utf8').catch(() => ''));
        });
        const appPid = Number((await readFile(starts, 'utf8')).trim());
        expect(await supervisorBirth(appPid)).toEqual(expect.any(String));
        // A disconnected long-lived app can be older than the history page.
        for (let i = 0; i < 130; i++) {
          const next = launch(store.taskId, directory);
          const nextState = {
            ...starting(next),
            startedAt: state.startedAt + 1 + i,
          };
          store.journal.reserve(next, nextState);
          store.journal.finish(nextState.runId, 'exited');
        }
        store.sqlite.close();
        store = await database(directory);
        host = new TaskAppHost(undefined, store.journal);
        expect(host.list(store.taskId)[0]).toMatchObject({
          runId: state.runId,
          status: 'stopping',
        });
        expect(host.count(store.taskId)).toBe(1);
        expect(host.beginRuntimeHandoff()).toBe(1);
        expect((await host.start(request)).status).toBe('stopping');
        owner.kill('SIGKILL');
        await ownerClosed;
        await host.stopAll(store.taskId);
        expect(await supervisorBirth(appPid)).toBeNull();
        expect((await host.start(request)).runId).toBe(state.runId);
        expect(host.get(store.taskId, state.runId).status).toBe('failed');
        expect(await readFile(starts, 'utf8')).toBe(appPid + '\n');
        expect(host.count(store.taskId)).toBe(0);
        await expect(access(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        if (owner.exitCode === null && owner.signalCode === null)
          owner.kill('SIGKILL');
        await ownerClosed;
        await host?.onModuleDestroy();
        store.sqlite.close();
        await rm(scratch, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
