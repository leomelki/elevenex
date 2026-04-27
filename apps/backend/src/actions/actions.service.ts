import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { ActionPtyManager } from './action-pty-manager.service.js';

type ActionStatus = 'idle' | 'running' | 'success' | 'failed' | 'stopped';

@Injectable()
export class ActionsService implements OnModuleInit {
  private readonly logger = new Logger('ActionsService');

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly ptyManager: ActionPtyManager,
  ) {
    this.ptyManager.registerPersistence({
      markRunning: (actionId) => this.markRunning(actionId),
      flushCurrentOutput: (actionId, output) => this.flushCurrentOutput(actionId, output),
      finalizeRun: (actionId, payload) => this.finalizeRun(actionId, payload),
    });
  }

  async onModuleInit(): Promise<void> {
    const runningActions = await this.db
      .select()
      .from(schema.actions)
      .where(eq(schema.actions.status, 'running'));

    for (const action of runningActions) {
      if (this.ptyManager.hasTmuxSessionForAction(action.id)) {
        this.logger.log(`Action ${action.id} ("${action.name}") has surviving tmux session, reattaching...`);
        const reattached = await this.ptyManager.reattach(action.id);
        if (reattached) {
          this.logger.log(`Successfully reattached to action ${action.id}`);
          continue;
        }
        this.logger.warn(`Failed to reattach to action ${action.id}, marking as stopped`);
      }

      const now = new Date().toISOString();
      await this.db
        .update(schema.actions)
        .set({
          status: 'stopped',
          currentOutput: '',
          updatedAt: now,
          lastFinishedAt: now,
        })
        .where(eq(schema.actions.id, action.id));
    }
  }

  async create(dto: { worktreePath: string; name: string; command: string }) {
    const timestamp = new Date().toISOString();
    const rows = await this.db
      .insert(schema.actions)
      .values({
        worktreePath: dto.worktreePath,
        name: dto.name.trim(),
        command: dto.command.trim(),
        status: 'idle',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning();

    return rows[0];
  }

  async listByWorktree(worktreePath: string) {
    return this.db
      .select()
      .from(schema.actions)
      .where(eq(schema.actions.worktreePath, worktreePath))
      .orderBy(asc(schema.actions.createdAt));
  }

  async getRunningCount(worktreePath: string) {
    const rows = await this.db
      .select()
      .from(schema.actions)
      .where(and(
        eq(schema.actions.worktreePath, worktreePath),
        eq(schema.actions.status, 'running'),
      ));

    return { count: rows.length };
  }

  async findOne(id: number) {
    const rows = await this.db
      .select()
      .from(schema.actions)
      .where(eq(schema.actions.id, id));

    if (rows.length === 0) {
      throw new NotFoundException(`Action ${id} not found`);
    }

    return rows[0];
  }

  async update(id: number, dto: { name?: string; command?: string }) {
    const existing = await this.findOne(id);
    if (this.ptyManager.isRunning(id)) {
      throw new BadRequestException('Cannot edit a running action');
    }

    const updatePayload: Partial<typeof existing> = {
      updatedAt: new Date().toISOString(),
    };

    if (typeof dto.name === 'string') {
      updatePayload.name = dto.name.trim();
    }

    if (typeof dto.command === 'string') {
      updatePayload.command = dto.command.trim();
    }

    await this.db
      .update(schema.actions)
      .set(updatePayload)
      .where(eq(schema.actions.id, id));

    return this.findOne(id);
  }

  async remove(id: number) {
    const existing = await this.findOne(id);
    if (this.ptyManager.isRunning(id)) {
      throw new BadRequestException(`Action "${existing.name}" is running`);
    }

    this.ptyManager.killTmuxSession(id);

    await this.db
      .delete(schema.actions)
      .where(eq(schema.actions.id, id));

    return { success: true };
  }

  async run(id: number) {
    const action = await this.findOne(id);
    if (this.ptyManager.isRunning(id) || action.status === 'running') {
      throw new BadRequestException(`Action "${action.name}" is already running`);
    }

    await this.ptyManager.start({
      id: action.id,
      worktreePath: action.worktreePath,
      command: action.command,
    });

    return this.findOne(id);
  }

  async stop(id: number) {
    await this.findOne(id);
    const stopped = await this.ptyManager.stop(id);
    if (!stopped) {
      throw new BadRequestException('Action is not running');
    }

    return { success: true };
  }

  async markRunning(actionId: number): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .update(schema.actions)
      .set({
        status: 'running',
        lastRunAt: now,
        currentOutput: '',
        updatedAt: now,
      })
      .where(eq(schema.actions.id, actionId));
  }

  async flushCurrentOutput(actionId: number, output: string): Promise<void> {
    await this.db
      .update(schema.actions)
      .set({
        currentOutput: output,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.actions.id, actionId));
  }

  async finalizeRun(actionId: number, payload: {
    status: ActionStatus;
    currentOutput: string;
    lastOutput: string;
    lastExitCode: number | null;
    lastFinishedAt: string;
    updatedAt: string;
  }): Promise<void> {
    await this.db
      .update(schema.actions)
      .set(payload)
      .where(eq(schema.actions.id, actionId));
  }
}
