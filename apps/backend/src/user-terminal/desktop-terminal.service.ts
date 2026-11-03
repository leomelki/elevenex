import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { assertWorkspaceCanExecute } from '../workspaces/workspace-ownership.js';
import { UserTerminalService } from './user-terminal.service.js';
import { UserPtyManager } from './user-pty-manager.service.js';

export function terminalObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('Invalid terminal request');
  return value as Record<string, unknown>;
}
export function terminalId(value: unknown): number {
  if (typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value))
    value = Number(value);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new BadRequestException('Invalid terminal identity');
  return value;
}
function generation(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f\d-]{36}$/.test(value))
    throw new BadRequestException('Invalid process generation');
  return value;
}

@Injectable()
export class DesktopTerminalService implements OnModuleInit, OnModuleDestroy {
  private readonly engineOwner = randomUUID();
  private stopping = false;
  private readonly launches = new Set<Promise<unknown>>();
  private readonly closingOwners = new Set<string>();

  async onModuleInit() {
    // Direct desktop PTYs cannot survive an engine restart, including a crash.
    await this.db
      .delete(schema.userTerminals)
      .where(isNotNull(schema.userTerminals.desktopOwner));
  }

  async onModuleDestroy() {
    this.stopping = true;
    await Promise.allSettled(this.launches);
    await this.closeOwned();
  }

  async closeOwned(owner?: string) {
    if (owner !== undefined) generation(owner);
    if (owner !== undefined) this.closingOwners.add(owner);
    try {
      await Promise.allSettled(this.launches);
      // Bounded batches include exited tabs, whose scrollback was only in memory.
      const condition =
        owner === undefined
          ? isNotNull(schema.userTerminals.desktopOwner)
          : eq(schema.userTerminals.desktopOwner, owner);
      for (;;) {
        const rows = await this.db
          .select({ id: schema.userTerminals.id })
          .from(schema.userTerminals)
          .where(condition)
          .limit(16);
        if (!rows.length) break;
        await Promise.all(
          rows.map(async ({ id }) => {
            await this.ptys.destroy(id, true);
            await this.db
              .delete(schema.userTerminals)
              .where(eq(schema.userTerminals.id, id));
            this.ptys.forgetDesktop(id);
          }),
        );
      }
      return { accepted: true as const };
    } finally {
      if (owner !== undefined) this.closingOwners.delete(owner);
    }
  }
  private readonly creating = new Set<number>();
  private readonly scriptReads = new Map<
    string,
    {
      at: number;
      result: ReturnType<DesktopTerminalService['discoverScripts']>;
    }
  >();
  private scripts(cwd: string, fresh = false) {
    const cached = this.scriptReads.get(cwd);
    if (!fresh && cached && Date.now() - cached.at < 3000) return cached.result;
    const result = this.discoverScripts(cwd);
    this.scriptReads.delete(cwd);
    this.scriptReads.set(cwd, { at: Date.now(), result });
    while (this.scriptReads.size > 16) {
      const oldest = this.scriptReads.keys().next();
      if (oldest.done) break;
      this.scriptReads.delete(oldest.value);
    }
    return result;
  }
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly terminals: UserTerminalService,
    private readonly ptys: UserPtyManager,
  ) {}

  private async task(id: number, execute = false) {
    const [task] = await this.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id))
      .limit(1);
    if (!task || task.isDefault) throw new NotFoundException('Task not found');
    if (execute) {
      const current = await assertWorkspaceCanExecute(this.db, id);
      if (!current || current.isDefault)
        throw new NotFoundException('Task not found');
      return current;
    }
    return task;
  }
  private async owned(taskId: number, id: number, execute = false) {
    const task = await this.task(taskId, execute),
      terminal = await this.terminals.findOne(id);
    if (terminal.workspaceId !== taskId)
      throw new NotFoundException('Terminal does not belong to task');
    if (execute && terminal.worktreePath !== task.path)
      throw new ConflictException(
        'The task checkout changed. Open a new terminal.',
      );
    return { task, terminal };
  }
  private view(
    task: typeof schema.workspaces.$inferSelect,
    terminal: typeof schema.userTerminals.$inferSelect,
  ) {
    const stream = this.ptys.desktopStream(terminal.id);
    return {
      id: terminal.id,
      taskId: task.id,
      title: terminal.name.slice(0, 120),
      cwd: terminal.worktreePath,
      branch: task.taskBranch ?? '',
      alive: this.ptys.isAlive(terminal.id),
      generation: stream?.generation ?? null,
      sequence: stream?.sequence ?? 0,
      status: stream?.status ?? 'unavailable',
      command: stream?.command ?? '',
      exitCode: stream?.exitCode ?? null,
      port: stream?.port ?? null,
      ...(stream?.protocol ? { protocol: stream.protocol } : {}),
      canRerun: stream?.canRerun ?? false,
    };
  }
  /** Only the root manifest, bounded bytes/rows; never run discovery scripts. */
  private async discoverScripts(cwd: string) {
    const manifest = path.join(cwd, 'package.json');
    try {
      const realRoot = await fs.realpath(cwd),
        real = await fs.realpath(manifest);
      if (path.dirname(real) !== realRoot) return [];
      const handle = await fs.open(real, 'r');
      let raw: unknown;
      try {
        if ((await handle.stat()).size > 256 * 1024) return [];
        const buffer = Buffer.alloc(256 * 1024 + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 256 * 1024) return [];
        raw = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      } finally {
        await handle.close();
      }
      const pkg = terminalObject(raw),
        scripts = terminalObject(pkg.scripts ?? {});
      const manager =
        typeof pkg.packageManager === 'string' &&
        /^(pnpm|yarn|npm)@/.test(pkg.packageManager)
          ? pkg.packageManager.split('@')[0]
          : await fs.access(path.join(cwd, 'pnpm-lock.yaml')).then(
              () => 'pnpm',
              () => 'npm',
            );
      return Object.entries(scripts)
        .filter(
          ([name, command]) =>
            /^[a-zA-Z0-9][\w:.-]{0,99}$/.test(name) &&
            typeof command === 'string',
        )
        .slice(0, 100)
        .map(([name]) => ({
          id: name,
          name,
          cmd: `${manager} run ${name}`,
          file:
            process.platform === 'win32'
              ? (process.env.ComSpec ?? 'cmd.exe')
              : manager,
          args:
            process.platform === 'win32'
              ? ['/d', '/s', '/c', `${manager} run ${name}`]
              : ['run', name],
        }));
    } catch {
      return [];
    }
  }
  async list(taskId: number) {
    const task = await this.task(taskId);
    const rows = await this.db
      .select()
      .from(schema.userTerminals)
      .where(
        and(
          eq(schema.userTerminals.workspaceId, taskId),
          isNotNull(schema.userTerminals.desktopOwner),
        ),
      )
      .orderBy(schema.userTerminals.id)
      .limit(16);
    const scripts = task.archivedAt ? [] : await this.scripts(task.path);
    return {
      taskId,
      terminals: rows.map((row) => this.view(task, row)),
      scripts: scripts.map(({ id, name, cmd }) => ({ id, name, cmd })),
      limit: 16,
    };
  }
  create(taskId: number, value: unknown) {
    if (this.stopping)
      throw new ConflictException('Terminal service is stopping');
    const launch = this.createInternal(taskId, value);
    this.launches.add(launch);
    void launch.finally(() => this.launches.delete(launch)).catch(() => {});
    return launch;
  }
  private async createInternal(taskId: number, value: unknown) {
    const input = terminalObject(value);
    if (
      Object.keys(input).some((key) => key !== 'scriptId' && key !== 'owner') ||
      (input.scriptId !== undefined &&
        (typeof input.scriptId !== 'string' || input.scriptId.length > 100))
    )
      throw new BadRequestException('Invalid terminal launch');
    const owner =
      input.owner === undefined ? this.engineOwner : generation(input.owner);
    if (this.closingOwners.has(owner))
      throw new ConflictException('Terminal application is closing');
    if (this.creating.has(taskId))
      throw new ConflictException('Another terminal is starting');
    this.creating.add(taskId);
    let id: number | undefined;
    try {
      const task = await this.task(taskId, true);
      const rows = await this.db
        .select({ id: schema.userTerminals.id })
        .from(schema.userTerminals)
        .where(
          and(
            eq(schema.userTerminals.workspaceId, taskId),
            isNotNull(schema.userTerminals.desktopOwner),
          ),
        )
        .limit(16);
      if (rows.length >= 16)
        throw new ConflictException('Close a terminal before opening another');
      const script =
        input.scriptId === undefined
          ? null
          : (await this.scripts(task.path, true)).find(
              (script) => script.id === input.scriptId,
            );
      if (input.scriptId !== undefined && !script)
        throw new BadRequestException('Script no longer exists');
      const terminal = await this.terminals.create({
        worktreePath: task.path,
        desktopOwner: owner,
        ...(script ? { name: script.name } : {}),
      });
      id = terminal.id;
      // Path-based legacy creation is reconciled against the durable owner before spawn.
      const latest = await this.task(taskId, true);
      if (
        terminal.workspaceId !== taskId ||
        latest.path !== terminal.worktreePath
      )
        throw new ConflictException('Task checkout changed');
      await this.ptys.spawnDesktop(
        id,
        latest.path,
        terminal.shell,
        script ?? null,
      );
      const final = await this.task(taskId, true);
      if (final.path !== latest.path)
        throw new ConflictException('Task checkout changed during startup');
      return this.view(final, terminal);
    } catch (error) {
      if (id !== undefined) {
        await this.terminals.remove(id);
        this.ptys.forgetDesktop(id);
      }
      throw error;
    } finally {
      this.creating.delete(taskId);
    }
  }
  async read(taskId: number, id: number, gen: unknown, after: unknown) {
    if (gen !== null && gen !== undefined) generation(gen);
    if (typeof after === 'string' && /^\d{1,16}$/.test(after))
      after = Number(after);
    if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0)
      throw new BadRequestException('Invalid output cursor');
    const { task, terminal } = await this.owned(taskId, id);
    const stream = this.ptys.desktopStream(id);
    return {
      terminal: this.view(task, terminal),
      ...(stream
        ? stream.read(typeof gen === 'string' ? gen : null, after)
        : {
            generation: null,
            from: 0,
            next: 0,
            data: '',
            gap: gen !== null,
            more: false,
          }),
    };
  }
  async command(taskId: number, id: number, value: unknown) {
    const input = terminalObject(value);
    const type = input.type;
    const keys: Record<string, string[]> = {
      input: ['type', 'generation', 'data'],
      resize: ['type', 'generation', 'cols', 'rows'],
      interrupt: ['type', 'generation'],
      rerun: ['type', 'generation'],
    };
    if (
      typeof type !== 'string' ||
      !keys[type] ||
      Object.keys(input).some((key) => !keys[type].includes(key))
    )
      throw new BadRequestException('Invalid terminal operation');
    const { terminal, task } = await this.owned(taskId, id, true);
    const stream = this.ptys.desktopStream(id);
    if (!stream || stream.generation !== generation(input.generation))
      throw new ConflictException('Terminal process changed');
    if (type === 'rerun' && stream.canRerun && stream.script) {
      const script = (await this.scripts(task.path, true)).find(
        (script) => script.id === stream.script?.id,
      );
      if (!script) throw new ConflictException('Script no longer exists');
      await this.ptys.destroy(id, true);
      this.ptys.forgetDesktop(id);
      await this.ptys.spawnDesktop(id, task.path, terminal.shell, script);
    } else {
      if (!this.ptys.isAlive(id))
        throw new ConflictException('Terminal has exited');
      if (type === 'input') {
        if (
          typeof input.data !== 'string' ||
          !input.data ||
          Buffer.byteLength(input.data) > 32768
        )
          throw new BadRequestException('Invalid terminal input');
        this.ptys.write(id, input.data);
      } else if (type === 'resize') {
        if (
          typeof input.cols !== 'number' ||
          typeof input.rows !== 'number' ||
          !Number.isInteger(input.cols) ||
          !Number.isInteger(input.rows) ||
          input.cols < 2 ||
          input.cols > 500 ||
          input.rows < 1 ||
          input.rows > 300
        )
          throw new BadRequestException('Invalid terminal size');
        this.ptys.resize(id, input.cols, input.rows);
      } else if (type === 'interrupt') this.ptys.write(id, '\x03');
      else if (type === 'rerun' && stream.rerunInput())
        this.ptys.write(id, stream.rerunInput()!);
      else throw new ConflictException('There is no repeatable failed command');
    }
    return { accepted: true as const };
  }
  async close(taskId: number, id: number) {
    await this.owned(taskId, id);
    await this.ptys.destroy(id, true);
    await this.terminals.remove(id);
    this.ptys.forgetDesktop(id);
    return { accepted: true as const };
  }
}
