import { createServer, type Server } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createTestDb } from '../database/testing/create-test-db.js';
import * as schema from '../database/schema/index.js';
import { UserPtyManager } from './user-pty-manager.service.js';
import { UserTerminalService } from './user-terminal.service.js';
import { DesktopTerminalService } from './desktop-terminal.service.js';

const waitFor = async <T>(
  read: () => T | null | Promise<T | null>,
): Promise<T> => {
  const until = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > until) throw new Error('Listener condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
};

const suite = existsSync('/bin/bash') ? describe : describe.skip;
suite('Task terminal ports with real process trees and TCP listeners', () => {
  let root: string;
  let db: ReturnType<typeof createTestDb>;
  let ptys: UserPtyManager;
  let service: DesktopTerminalService;
  let task: number;
  let unrelated: Server;
  let unrelatedPort: number;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'elevenex-terminal-ports-'));
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { silent: 'node wrapper.cjs' } }),
    );
    // A package manager -> wrapper -> silent server process chain. No listening
    // URL is printed, and both IPv4 and IPv6 are open at the same time.
    await writeFile(
      join(root, 'wrapper.cjs'),
      `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, [require('node:path').join(__dirname, 'listener.cjs')], { stdio: 'inherit' });
      child.once('exit', code => process.exit(code ?? 0));
      process.once('SIGTERM', () => child.kill());
    `,
    );
    await writeFile(
      join(root, 'listener.cjs'),
      `
      const net = require('node:net'), fs = require('node:fs');
      const path = require('node:path');
      const ports = [], servers = ['127.0.0.1', '::1'].map(host => {
        const server = net.createServer(socket => socket.end());
        server.listen(0, host, () => {
          ports.push({ host, port: server.address().port });
          if (ports.length === 2) fs.writeFileSync(path.join(__dirname, 'ports.json'), JSON.stringify(ports));
        });
        return server;
      });
      const stop = () => { clearInterval(timer); let left = servers.length;
        for (const server of servers) server.close(() => { if (--left === 0) process.exit(0); });
      };
      const timer = setInterval(() => { if (fs.existsSync(path.join(__dirname, 'stop'))) stop(); }, 40);
      process.once('SIGTERM', stop);
    `,
    );
    db = createTestDb();
    const [project] = db.db
      .insert(schema.projects)
      .values({ name: 'Ports' })
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
        name: 'ports',
        path: root,
        taskBranch: 'ports',
      })
      .returning()
      .all();
    task = workspace.id;
    ptys = new UserPtyManager({
      sendToTerminal: () => {},
      onProcessExit: () => {},
    } as never);
    service = new DesktopTerminalService(
      db.db,
      new UserTerminalService(db.db, ptys),
      ptys,
    );
    unrelated = createServer((socket) => socket.end());
    await new Promise<void>((resolve) =>
      unrelated.listen(0, '127.0.0.1', resolve),
    );
    const address = unrelated.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing test listener');
    unrelatedPort = address.port;
  });

  afterAll(async () => {
    await writeFile(join(root, 'stop'), '').catch(() => {});
    await service.closeOwned();
    ptys.onModuleDestroy();
    await new Promise<void>((resolve) => unrelated.close(() => resolve()));
    db.sqlite.close();
    await rm(root, { recursive: true, force: true });
  });

  it('finds silent nested servers, excludes unrelated sockets and freshly rejects closed services', async () => {
    const terminal = await service.create(task, { scriptId: 'silent' });
    const ports = await waitFor(async () => {
      try {
        return JSON.parse(await readFile(join(root, 'ports.json'), 'utf8')) as {
          host: string;
          port: number;
        }[];
      } catch {
        return null;
      }
    });
    const row = await waitFor(async () => {
      const row = (await service.list(task)).terminals.find(
        (row) => row.id === terminal.id,
      );
      return row?.services.length === 2 ? row : null;
    });
    expect(row.status).toBe('serving');
    expect(row.portDiscovery).toBe('process');
    expect(row.services.map((entry) => entry.port).sort()).toEqual(
      ports.map((entry) => entry.port).sort(),
    );
    expect(row.services.some((entry) => entry.port === unrelatedPort)).toBe(
      false,
    );
    const ipv6 = ports.find((entry) => entry.host === '::1')!;
    expect(
      (await service.service(task, terminal.id, terminal.generation, ipv6.port))
        .service.host,
    ).toBe('::1');
    await expect(
      service.service(task, terminal.id, terminal.generation, unrelatedPort),
    ).rejects.toThrow('no longer listening');
    await expect(
      service.service(task + 999, terminal.id, terminal.generation, ipv6.port),
    ).rejects.toThrow();
    await writeFile(join(root, 'stop'), '');
    await waitFor(() => (ptys.isAlive(terminal.id) ? null : true));
    await expect(
      service.service(task, terminal.id, terminal.generation, ipv6.port),
    ).rejects.toThrow('process changed');
    expect(
      (await service.list(task)).terminals.find((row) => row.id === terminal.id)
        ?.port,
    ).toBeNull();
  }, 30_000);

  it('does not mark a printed URL as serving when its socket belongs to another process', async () => {
    const terminal = await service.create(task, { shellIntegration: false });
    await service.command(task, terminal.id, {
      type: 'input',
      generation: terminal.generation,
      data: `printf 'https://localhost:${unrelatedPort}/app/\\n'\r`,
    });
    await waitFor(async () =>
      (await service.read(task, terminal.id, null, 0)).data.includes(
        `/app/\r\n`,
      )
        ? true
        : null,
    );
    await ptys.refreshDesktopPorts(true);
    const row = (await service.list(task)).terminals.find(
      (row) => row.id === terminal.id,
    )!;
    expect(row.port).toBeNull();
    expect(row.status).not.toBe('serving');
  }, 20_000);

  it('keeps background servers owned after the prompt returns and removes ports while the shell stays alive', async () => {
    await rm(join(root, 'stop'), { force: true });
    await rm(join(root, 'ports.json'), { force: true });
    const terminal = await service.create(task, { shellIntegration: false });
    await service.command(task, terminal.id, {
      type: 'input',
      generation: terminal.generation,
      data: 'node wrapper.cjs &\r',
    });
    const ports = await waitFor(async () => {
      try {
        return JSON.parse(await readFile(join(root, 'ports.json'), 'utf8')) as {
          host: string;
          port: number;
        }[];
      } catch {
        return null;
      }
    });
    const target = ports.find((entry) => entry.host === '127.0.0.1')!;
    await waitFor(async () => {
      const row = (await service.list(task)).terminals.find(
        (row) => row.id === terminal.id,
      );
      return row?.services.length === 2 ? true : null;
    });
    await service.command(task, terminal.id, {
      type: 'input',
      generation: terminal.generation,
      data: `printf 'https://localhost:${target.port}/app/?token=private\\n'\r`,
    });
    await waitFor(async () =>
      (await service.read(task, terminal.id, null, 0)).data.includes(
        `/app/?token=private\r\n`,
      )
        ? true
        : null,
    );
    const checked = await service.service(
      task,
      terminal.id,
      terminal.generation,
      target.port,
    );
    expect(checked.service).toMatchObject({ protocol: 'https', path: '/app/' });
    await writeFile(join(root, 'stop'), '');
    await waitFor(async () => {
      try {
        await service.service(
          task,
          terminal.id,
          terminal.generation,
          target.port,
        );
        return null;
      } catch {
        return true;
      }
    });
    expect(ptys.isAlive(terminal.id)).toBe(true);
    const row = (await service.list(task)).terminals.find(
      (row) => row.id === terminal.id,
    )!;
    expect(row.port).toBeNull();
    expect(row.services).toEqual([]);
  }, 30_000);
});
