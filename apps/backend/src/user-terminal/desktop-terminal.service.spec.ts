import { eq } from 'drizzle-orm';
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
  it('reports server-generation loss without restarting a recorded terminal', async () => {
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
      await recovered.list(task);
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
});
