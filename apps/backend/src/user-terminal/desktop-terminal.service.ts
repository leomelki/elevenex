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
import { release } from 'node:os';
import { parseTerminalLaunch } from './terminal-launch.js';
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
  private readonly pendingWork = new Set<Promise<unknown>>();
  private readonly closingOwners = new Set<string>();
  private readonly mutations = new Map<number, Promise<unknown>>();

  /** Close, input and replacement share one terminal lifetime, across all clients. */
  private mutate<T>(id: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    this.mutations.set(id, pending);
    void pending
      .finally(() => {
        if (this.mutations.get(id) === pending) this.mutations.delete(id);
      })
      .catch(() => {});
    return pending;
  }

  private trackWork<T>(work: Promise<T>): Promise<T> {
    this.pendingWork.add(work);
    void work.finally(() => this.pendingWork.delete(work)).catch(() => {});
    return work;
  }

  async onModuleInit() {
    // Direct desktop PTYs cannot survive an engine restart, including a crash.
    await this.db
      .delete(schema.userTerminals)
      .where(isNotNull(schema.userTerminals.desktopOwner));
  }

  async onModuleDestroy() {
    this.stopping = true;
    await Promise.allSettled(this.pendingWork);
    await this.closeOwned();
  }

  async closeOwned(owner?: string) {
    if (owner !== undefined) generation(owner);
    if (owner !== undefined) this.closingOwners.add(owner);
    try {
      await Promise.allSettled(this.pendingWork);
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
          rows.map(({ id }) =>
            this.mutate(id, async () => {
              await this.ptys.destroy(id, true);
              await this.db
                .delete(schema.userTerminals)
                .where(eq(schema.userTerminals.id, id));
              this.ptys.forgetDesktop(id);
            }),
          ),
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
      // Saved names (including script names) own the tab. Keep the established
      // title contract and expose automatic activity as additive metadata only.
      activityTitle:
        terminal.name === path.basename(terminal.shell)
          ? (stream?.activityTitle ?? null)
          : null,
      cwd: terminal.worktreePath,
      currentCwd: stream?.tracking.cwd ?? null,
      commandTracking: true as const,
      branch: task.taskBranch ?? '',
      alive: this.ptys.isAlive(terminal.id),
      ...(process.platform === 'win32' ? { windowsPty: { backend: 'conpty' as const, buildNumber: Number(release().split('.')[2]) || 0 } } : {}),
      generation: stream?.generation ?? null,
      sequence: stream?.sequence ?? 0,
      status: stream?.status ?? 'unavailable',
      command: stream?.command ?? '',
      exitCode: stream?.exitCode ?? null,
      port: stream?.port ?? null,
      services: stream?.services.services ?? [],
      portDiscovery: stream?.services.discovery ?? 'unavailable',
      ...(stream?.protocol ? { protocol: stream.protocol } : {}),
      canRerun: stream?.canRerun ?? false,
      ...(stream?.integration ? { shellIntegration: stream.integration } : {}),
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
    await this.ptys.refreshDesktopPorts();
    return {
      taskId,
      terminals: rows.map((row) => this.view(task, row)),
      scripts: scripts.map(({ id, name, cmd }) => ({ id, name, cmd })),
      limit: 16,
      shellIntegrationControl: true,
      ...(this.ptys.screens.supported ? { streamVersion: 1 as const } : {}),
    };
  }
  create(taskId: number, value: unknown) {
    if (this.stopping)
      throw new ConflictException('Terminal service is stopping');
    return this.trackWork(this.createInternal(taskId, value));
  }
  private async createInternal(taskId: number, value: unknown) {
    const input = terminalObject(value);
    if (
      Object.keys(input).some(
        (key) => !['scriptId', 'owner', 'shellIntegration', 'size', 'profile', 'protocol'].includes(key),
      ) ||
      (input.shellIntegration !== undefined &&
        typeof input.shellIntegration !== 'boolean') ||
      (input.scriptId !== undefined &&
        (typeof input.scriptId !== 'string' || input.scriptId.length > 100))
    )
      throw new BadRequestException('Invalid terminal launch');
    const launch = parseTerminalLaunch(input);
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
        ...(launch.profile && !script ? { shell: launch.profile.executable } : {}),
        ...(script ? { name: script.name } : {}),
      });
      id = terminal.id;
      // Ownership validation is async; cleanup must retire this launch rather
      // than letting it acquire a newer cancellation fence afterward.
      const fence = this.ptys.getGeneration(id);
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
        fence,
        input.shellIntegration !== false,
        launch,
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
    // Output delivery never waits behind an OS process scan. Metadata list
    // polling awaits the same coalesced scan; subsequent output sees its result.
    void this.ptys.refreshDesktopPorts();
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
  /** Authorize once for observing this exact process. Writes still revalidate
   * durable task ownership through command(), including after queued work. */
  async attach(taskId: number, id: number) {
    let { task, terminal } = await this.owned(taskId, id);
    const stream = this.ptys.desktopStream(id);
    if (!terminal.desktopOwner || !stream || !this.ptys.screens.available)
      throw new ConflictException('Terminal screen is unavailable');
    stream.protocolOwned = true;
    return {
      stream,
      read: (gen: string | null, after: number) => ({ terminal: this.view(task, terminal), ...stream.read(gen, after) }),
      snapshot: () => this.ptys.screens.snapshot(id),
      refresh: async () => { const latest = await this.owned(taskId, id); task = latest.task; terminal = latest.terminal; },
      current: () => this.ptys.desktopStream(id) === stream && this.ptys.screens.available,
    };
  }
  async context(taskId: number, id: number, gen: unknown): Promise<string> {
    await this.owned(taskId, id);
    if (this.ptys.desktopStream(id)?.generation !== generation(gen)) throw new ConflictException('Terminal process changed');
    return this.ptys.screens.context(id);
  }
  async service(taskId: number, id: number, gen: unknown, port: unknown) {
    const expected = generation(gen);
    const target = terminalId(port);
    if (target > 65535) throw new BadRequestException('Invalid service port');
    await this.owned(taskId, id);
    const stream = this.ptys.desktopStream(id);
    if (!stream || stream.generation !== expected || !this.ptys.isAlive(id))
      throw new ConflictException('Terminal process changed');
    await this.ptys.refreshDesktopPorts(true);
    // A close/replacement can finish while the platform collector is running.
    if (this.ptys.desktopStream(id) !== stream || !this.ptys.isAlive(id))
      throw new ConflictException('Terminal process changed');
    const service = stream.services.services.find(
      (entry) => entry.port === target,
    );
    if (!service || stream.services.discovery !== 'process')
      throw new ConflictException('The service is no longer listening');
    return { generation: expected, service };
  }
  async commands(taskId: number, id: number, gen: unknown, after: unknown) {
    if (gen !== null && gen !== undefined) generation(gen);
    if (typeof after === 'string' && /^\d{1,16}$/.test(after))
      after = Number(after);
    if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0)
      throw new BadRequestException('Invalid command cursor');
    await this.owned(taskId, id);
    const stream = this.ptys.desktopStream(id);
    const sameGeneration = gen === (stream?.generation ?? null);
    const page = stream?.tracking.page(sameGeneration ? after : 0) ?? {
      commands: [],
      current: null,
      next: 0,
      more: false,
      gap: after !== 0,
    };
    return {
      taskId,
      terminalId: id,
      generation: stream?.generation ?? null,
      ...page,
      gap: !sameGeneration || page.gap,
    };
  }
  command(taskId: number, id: number, value: unknown) {
    const command = this.mutate(id, () =>
      this.commandInternal(taskId, id, value),
    );
    // Shutdown must also await replacements already accepted by this service.
    return this.trackWork(command);
  }
  private async commandInternal(taskId: number, id: number, value: unknown) {
    const input = terminalObject(value);
    const type = input.type;
    const keys: Record<string, string[]> = {
      input: ['type', 'generation', 'data'],
      binary: ['type', 'generation', 'data'],
      resize: ['type', 'generation', 'cols', 'rows'],
      interrupt: ['type', 'generation'],
      rerun: ['type', 'generation'],
    };
    if (
      typeof type !== 'string' ||
      !Object.hasOwn(keys, type) ||
      Object.keys(input).some((key) => !keys[type].includes(key))
    )
      throw new BadRequestException('Invalid terminal operation');
    const { terminal, task } = await this.owned(taskId, id, true);
    const stream = this.ptys.desktopStream(id);
    if (!stream || stream.generation !== generation(input.generation))
      throw new ConflictException('Terminal process changed');
    if (
      type === 'rerun' &&
      (this.stopping ||
        (terminal.desktopOwner &&
          this.closingOwners.has(terminal.desktopOwner)))
    )
      throw new ConflictException('Terminal application is closing');
    if (type === 'rerun' && stream.canRerun && stream.script) {
      const fence = this.ptys.getGeneration(id);
      const script = (await this.scripts(task.path, true)).find(
        (script) => script.id === stream.script?.id,
      );
      if (!script) throw new ConflictException('Script no longer exists');
      if (
        this.ptys.getGeneration(id) !== fence ||
        this.ptys.desktopStream(id) !== stream
      )
        throw new ConflictException('Terminal process changed');
      await this.ptys.destroy(id, true);
      // Task finishing and legacy cleanup also advance this manager-owned fence.
      // A replacement may never acquire a newer fence after asynchronous work.
      const latest = await this.owned(taskId, id, true);
      if (
        latest.task.path !== task.path ||
        this.ptys.getGeneration(id) !== fence + 1 ||
        this.stopping ||
        (terminal.desktopOwner && this.closingOwners.has(terminal.desktopOwner))
      )
        throw new ConflictException(
          'Terminal ownership changed during restart',
        );
      this.ptys.forgetDesktop(id);
      await this.ptys.spawnDesktop(
        id,
        task.path,
        terminal.shell,
        script,
        fence + 1,
        true,
        stream.launch,
      );
      try {
        const final = await this.owned(taskId, id, true);
        if (final.task.path !== task.path)
          throw new ConflictException('Task checkout changed');
      } catch (error) {
        if (this.ptys.getGeneration(id) === fence + 1) {
          await this.ptys.destroy(id, true);
          this.ptys.forgetDesktop(id);
        }
        throw error;
      }
    } else {
      if (type !== 'resize' && !this.ptys.isAlive(id))
        throw new ConflictException('Terminal has exited');
      if (type === 'input' || type === 'binary') {
        if (
          typeof input.data !== 'string' ||
          !input.data ||
          Buffer.byteLength(input.data) > 32768
        )
          throw new BadRequestException('Invalid terminal input');
        if (type === 'binary') {
          if (/[^\x00-\xff]/.test(input.data)) throw new BadRequestException('Invalid binary terminal input');
          this.ptys.writeBinary(id, input.data);
        } else this.ptys.write(id, input.data);
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
        // A view can resize while the process exits. Retained output remains
        // observable at its final grid; there is no live PTY left to resize.
        if (this.ptys.isAlive(id)) this.ptys.resize(id, input.cols, input.rows);
      } else if (type === 'interrupt') this.ptys.write(id, '\x03');
      else if (type === 'rerun' && stream.rerunInput())
        this.ptys.write(id, stream.rerunInput()!);
      else throw new ConflictException('There is no repeatable failed command');
    }
    return { accepted: true as const };
  }
  close(taskId: number, id: number) {
    return this.mutate(id, async () => {
      await this.owned(taskId, id);
      await this.ptys.destroy(id, true);
      await this.terminals.remove(id);
      this.ptys.forgetDesktop(id);
      return { accepted: true as const };
    });
  }
}
