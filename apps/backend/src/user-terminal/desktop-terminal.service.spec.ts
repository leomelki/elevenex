import { eq } from 'drizzle-orm';
import { BadRequestException } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '../database/testing/create-test-db.js';
import * as schema from '../database/schema/index.js';
import { UserPtyManager } from './user-pty-manager.service.js';
import { UserTerminalService } from './user-terminal.service.js';
import { DesktopTerminalService } from './desktop-terminal.service.js';

const waitFor = async (predicate: () => boolean | Promise<boolean>) => {
  const until = Date.now() + 12000;
  while (!(await predicate())) {
    if (Date.now() > until) throw new Error('Terminal condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('Desktop task terminals with real PTYs', () => {
  let db: ReturnType<typeof createTestDb>,
    root: string,
    task: number,
    ptys: UserPtyManager,
    service: DesktopTerminalService;
  const ids: number[] = [];
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'elevenex-user-terminal-test-'));
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: {
          fail: 'node -e "console.log(\'failure context\');process.exit(7)"',
        },
      }),
    );
    db = createTestDb();
    const [project] = db.db
      .insert(schema.projects)
      .values({ name: 'Terminals' })
      .returning()
      .all();
    const [repo] = db.db
      .insert(schema.repos)
      .values({ projectId: project.id, name: 'repo', path: root })
      .returning()
      .all();
    const [workspace] = db.db
      .insert(schema.workspaces)
      .values({
        repoId: repo.id,
        name: 'task',
        path: root,
        taskBranch: 'feature/terminal',
      })
      .returning()
      .all();
    task = workspace.id;
    ptys = new UserPtyManager({
      sendToTerminal: () => {},
      onProcessExit: () => {},
    } as never);
    const oldShell = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    const terminals = new UserTerminalService(db.db, ptys);
    if (oldShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = oldShell;
    service = new DesktopTerminalService(db.db, terminals, ptys);
  });
  beforeEach(async () => {
    await db.db
      .update(schema.workspaces)
      .set({ path: root, taskState: 'ready' })
      .where(eq(schema.workspaces.id, task));
  });
  afterAll(async () => {
    for (const id of ids) await ptys.destroy(id, true);
    ptys.onModuleDestroy();
    db.sqlite.close();
    await rm(root, { recursive: true, force: true });
  });
  it('read/list do not create a shell; durable task identity determines the startup cwd', async () => {
    expect((await service.list(task)).terminals).toEqual([]);
    const cwd = join(root, 'moved');
    await mkdir(cwd);
    await db.db
      .update(schema.workspaces)
      .set({ path: cwd })
      .where(eq(schema.workspaces.id, task));
    const terminal = await service.create(task, {});
    ids.push(terminal.id);
    expect(terminal.cwd).toBe(cwd);
    expect(terminal.taskId).toBe(task);
    await service.command(task, terminal.id, {
      type: 'input',
      generation: terminal.generation,
      data: 'printf \'CWD=%s\\n\' "$PWD"\r',
    });
    await waitFor(async () =>
      (await service.read(task, terminal.id, null, 0)).data.includes(
        `CWD=${cwd}`,
      ),
    );
    const generation = terminal.generation;
    await service.read(task, terminal.id, generation, 0);
    await service.list(task);
    expect(ptys.desktopStream(terminal.id)?.generation).toBe(generation);
    expect(ptys.isAlive(terminal.id)).toBe(true);
    await service.command(task, terminal.id, {
      type: 'resize',
      generation,
      cols: 101,
      rows: 31,
    });
    await waitFor(() => ptys.desktopStream(terminal.id)?.status === 'idle');
    await service.command(task, terminal.id, {
      type: 'input',
      generation,
      data: 'false\r',
    });
    await waitFor(() => ptys.desktopStream(terminal.id)?.status === 'failed');
    expect(ptys.desktopStream(terminal.id)?.command).toBe('false');
    await service.command(task, terminal.id, { type: 'rerun', generation });
    await waitFor(() => ptys.desktopStream(terminal.id)?.status === 'failed');
    await service.command(task, terminal.id, {
      type: 'input',
      generation,
      data: "printf 'WAIT_%s\\n' READY; sleep 30\r",
    });
    await waitFor(async () =>
      (await service.read(task, terminal.id, generation, 0)).data.includes(
        'WAIT_READY',
      ),
    );
    await service.command(task, terminal.id, { type: 'interrupt', generation });
    await waitFor(() => ptys.desktopStream(terminal.id)?.exitCode === 130);
    await service.command(task, terminal.id, {
      type: 'input',
      generation,
      data: 'exit\r',
    });
    await waitFor(() => !ptys.isAlive(terminal.id));
    await service.read(task, terminal.id, generation, 0);
    expect(ptys.isAlive(terminal.id)).toBe(false);
    await db.db
      .update(schema.workspaces)
      .set({ path: root })
      .where(eq(schema.workspaces.id, task));
  });
  it('runs discovered scripts explicitly; failure retains context and rerun creates a fresh generation', async () => {
    const list = await service.list(task);
    expect(list.scripts[0].id).toBe('fail');
    const terminal = await service.create(task, { scriptId: 'fail' });
    ids.push(terminal.id);
    await waitFor(() => !ptys.isAlive(terminal.id));
    const output = await service.read(task, terminal.id, null, 0);
    expect(output.terminal.exitCode).toBe(7);
    expect(output.data).toContain('failure context');
    expect(output.terminal.canRerun).toBe(true);
    await service.command(task, terminal.id, {
      type: 'rerun',
      generation: terminal.generation,
    });
    expect(ptys.desktopStream(terminal.id)?.generation).not.toBe(
      terminal.generation,
    );
    await waitFor(() => !ptys.isAlive(terminal.id));
    expect(
      (await service.read(task, terminal.id, terminal.generation, output.next))
        .gap,
    ).toBe(true);
    await service.close(task, terminal.id);
    expect(ptys.desktopStream(terminal.id)).toBeUndefined();
  });
  it.each(['constructor', 'toString', '__proto__'])(
    'rejects inherited operation name %s as a bad request',
    async (type) => {
      await expect(service.command(task, 1, { type })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    },
  );
  it.each([
    { shell: '/bin/bash', paste: false },
    ...(existsSync('/bin/zsh')
      ? [
          { shell: '/bin/zsh', paste: false },
          { shell: '/bin/zsh', paste: true },
        ]
      : []),
  ])(
    'actually repeats a failed command in $shell (paste: $paste)',
    async ({ shell, paste }) => {
      const terminal = await service.create(task, {});
      ids.push(terminal.id);
      await ptys.destroy(terminal.id, true);
      ptys.forgetDesktop(terminal.id);
      await ptys.spawnDesktop(terminal.id, root, shell);
      const stream = ptys.desktopStream(terminal.id)!;
      await waitFor(() => stream.status === 'idle');
      const command = "printf 'RERUN_%s\\n' EXECUTED; false";
      await service.command(task, terminal.id, {
        type: 'input',
        generation: stream.generation,
        data: paste ? '\x1b[200~' + command + '\x1b[201~\r' : command + '\r',
      });
      await waitFor(() => stream.status === 'failed');
      expect(stream.command).toBe(command);
      const offset = stream.sequence;
      await service.command(task, terminal.id, {
        type: 'rerun',
        generation: stream.generation,
      });
      await waitFor(
        () => stream.status === 'failed' && stream.sequence > offset,
      );
      expect(stream.read(stream.generation, offset).data).toContain(
        'RERUN_EXECUTED',
      );
      await service.close(task, terminal.id);
    },
  );
  it('rejects task mismatches, stale process identity, oversized input and invalid dimensions', async () => {
    const terminal = await service.create(task, {});
    ids.push(terminal.id);
    await expect(
      service.read(task + 100, terminal.id, null, 0),
    ).rejects.toThrow();
    for (const input of [
      { type: 'input', generation: 'a'.repeat(36), data: 'echo wrong\r' },
      {
        type: 'input',
        generation: terminal.generation,
        data: 'x'.repeat(32769),
      },
      {
        type: 'resize',
        generation: terminal.generation,
        cols: Infinity,
        rows: 30,
      },
      {
        type: 'input',
        generation: terminal.generation,
        data: 'ok',
        shell: '/bin/sh',
      },
    ])
      await expect(service.command(task, terminal.id, input)).rejects.toThrow();
    await db.db
      .update(schema.workspaces)
      .set({ taskState: 'finishing' })
      .where(eq(schema.workspaces.id, task));
    await expect(
      service.command(task, terminal.id, {
        type: 'input',
        generation: terminal.generation,
        data: 'echo blocked\r',
      }),
    ).rejects.toThrow();
    await ptys.destroy(terminal.id, true);
    expect(ptys.isAlive(terminal.id)).toBe(false);
    await db.db
      .update(schema.workspaces)
      .set({ taskState: 'ready' })
      .where(eq(schema.workspaces.id, task));
  });
  it('expires desktop records on engine startup without restarting shells or removing legacy records', async () => {
    const terminal = await service.create(task, {});
    ids.push(terminal.id);
    await ptys.destroy(terminal.id, true);
    const replacement = new UserPtyManager({
      sendToTerminal: () => {},
      onProcessExit: () => {},
    } as never);
    try {
      const recovered = new DesktopTerminalService(
        db.db,
        new UserTerminalService(db.db, replacement),
        replacement,
      );
      const output = await recovered.read(
        task,
        terminal.id,
        terminal.generation,
        100,
      );
      expect(output.terminal.status).toBe('unavailable');
      expect(output.generation).toBeNull();
      expect(output.gap).toBe(true);
      expect(output.data).toBe('');
      const legacy = await new UserTerminalService(db.db, replacement).create({
        worktreePath: root,
      });
      await recovered.onModuleInit();
      expect((await recovered.list(task)).terminals).toEqual([]);
      await expect(recovered.read(task, terminal.id, null, 0)).rejects.toThrow(
        'not found',
      );
      expect(
        await db.db
          .select()
          .from(schema.userTerminals)
          .where(eq(schema.userTerminals.id, legacy.id)),
      ).toHaveLength(1);
      expect(replacement.isAlive(terminal.id)).toBe(false);
    } finally {
      replacement.onModuleDestroy();
    }
  });
  it('invalidates desktop identity when an existing client explicitly restarts the shell', async () => {
    const terminal = await service.create(task, {});
    ids.push(terminal.id);
    await ptys.destroy(terminal.id, true);
    const legacy = new UserTerminalService(db.db, ptys);
    expect((await legacy.startTerminal(terminal.id)).success).toBe(true);
    const output = await service.read(
      task,
      terminal.id,
      terminal.generation,
      0,
    );
    expect(output.generation).toBeNull();
    expect(output.terminal.status).toBe('unavailable');
    expect(output.gap).toBe(true);
    await expect(
      service.command(task, terminal.id, {
        type: 'input',
        generation: terminal.generation,
        data: 'stale keystrokes\r',
      }),
    ).rejects.toThrow();
  });
  it('closes only this application owner, including exited tabs, and frees the task for a fresh shell', async () => {
    const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const otherOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const shell = await service.create(task, { owner });
    const script = await service.create(task, { owner, scriptId: 'fail' });
    const other = await service.create(task, { owner: otherOwner });
    ids.push(shell.id, script.id, other.id);
    await waitFor(() => !ptys.isAlive(script.id));
    await expect(service.closeOwned('invalid')).rejects.toThrow();
    await service.closeOwned(owner);
    expect(ptys.isAlive(shell.id)).toBe(false);
    expect(ptys.desktopStream(shell.id)).toBeUndefined();
    expect(
      (await service.list(task)).terminals.map((row) => row.id),
    ).not.toContain(shell.id);
    expect(ptys.isAlive(other.id)).toBe(true);
    const shutdown = new DesktopTerminalService(
      db.db,
      new UserTerminalService(db.db, ptys),
      ptys,
    );
    await shutdown.onModuleDestroy();
    expect((await service.list(task)).terminals).toEqual([]);
    expect(ptys.isAlive(other.id)).toBe(false);
    expect(() => shutdown.create(task, {})).toThrow('stopping');
    const fresh = await service.create(task, {});
    ids.push(fresh.id);
    expect(fresh.alive).toBe(true);
    expect(fresh.generation).not.toBe(shell.generation);
    await service.close(task, fresh.id);
  });
  it('waits for an in-flight launch before app cleanup removes the process and record', async () => {
    const owner = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spawn = ptys.spawnDesktop.bind(ptys);
    const spy = jest
      .spyOn(ptys, 'spawnDesktop')
      .mockImplementation(async (...args) => {
        await gate;
        return spawn(...args);
      });
    const launch = service.create(task, { owner });
    try {
      await waitFor(() => spy.mock.calls.length > 0);
      const cleanup = service.closeOwned(owner);
      release();
      const terminal = await launch;
      ids.push(terminal.id);
      await cleanup;
      expect(ptys.isAlive(terminal.id)).toBe(false);
      expect(ptys.desktopStream(terminal.id)).toBeUndefined();
      expect(
        await db.db
          .select()
          .from(schema.userTerminals)
          .where(eq(schema.userTerminals.id, terminal.id)),
      ).toEqual([]);
    } finally {
      release();
      spy.mockRestore();
    }
  });
  it('retains the record when strict process cleanup fails so shutdown cannot falsely report success', async () => {
    const owner = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const terminal = await service.create(task, { owner });
    ids.push(terminal.id);
    const stop = jest
      .spyOn(ptys, 'destroy')
      .mockRejectedValueOnce(new Error('Process did not stop'));
    try {
      await expect(service.closeOwned(owner)).rejects.toThrow(
        'Process did not stop',
      );
      expect(
        (await service.list(task)).terminals.some(
          (row) => row.id === terminal.id,
        ),
      ).toBe(true);
      expect(ptys.isAlive(terminal.id)).toBe(true);
    } finally {
      stop.mockRestore();
      await service.closeOwned(owner);
    }
    expect(ptys.isAlive(terminal.id)).toBe(false);
  });
  it.each(['close', 'owner cleanup', 'task finish'] as const)(
    'fences a pending script rerun against %s',
    async (action) => {
      const owner = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      const terminal = await service.create(task, { owner, scriptId: 'fail' });
      ids.push(terminal.id);
      await waitFor(() => ptys.desktopStream(terminal.id)?.canRerun === true);
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const open = fs.open.bind(fs);
      const discovery = jest
        .spyOn(fs, 'open')
        .mockImplementation(async (...args) => {
          if (String(args[0]).endsWith('/package.json')) {
            entered();
            await gate;
          }
          return open(...args);
        });
      const rerun = service.command(task, terminal.id, {
        type: 'rerun',
        generation: terminal.generation,
      });
      // Attach rejection handling before triggering the race.
      const outcome = rerun.then(
        () => null,
        (error: unknown) => error,
      );
      try {
        await started;
        let closing: Promise<unknown> | undefined;
        if (action === 'close') closing = service.close(task, terminal.id);
        else if (action === 'owner cleanup')
          closing = service.closeOwned(owner);
        else {
          await db.db
            .update(schema.workspaces)
            .set({ taskState: 'finishing' })
            .where(eq(schema.workspaces.id, task));
          await ptys.destroy(terminal.id, true);
        }
        release();
        const error = await outcome;
        await closing;
        if (action !== 'close') expect(error).toBeInstanceOf(Error);
        expect(ptys.isAlive(terminal.id)).toBe(false);
        if (action !== 'task finish') {
          expect(
            (await service.list(task)).terminals.some(
              (row) => row.id === terminal.id,
            ),
          ).toBe(false);
          expect(ptys.desktopStream(terminal.id)).toBeUndefined();
        }
      } finally {
        release();
        discovery.mockRestore();
        await outcome;
      }
    },
  );
  it('rejects a delayed desktop launch using a fence retired by task cleanup', async () => {
    const terminal = await service.create(task, { scriptId: 'fail' });
    ids.push(terminal.id);
    await waitFor(() => !ptys.isAlive(terminal.id));
    const fence = ptys.getGeneration(terminal.id);
    await ptys.destroy(terminal.id, true);
    ptys.forgetDesktop(terminal.id);
    await expect(
      ptys.spawnDesktop(terminal.id, root, '/bin/bash', null, fence),
    ).rejects.toThrow('cancelled');
    expect(ptys.isAlive(terminal.id)).toBe(false);
    expect(ptys.desktopStream(terminal.id)).toBeUndefined();
  });
});
