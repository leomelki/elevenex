import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter } from 'events';
import { and, asc, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { ActionPtyManager } from './action-pty-manager.service.js';

type ActionStatus = 'idle' | 'running' | 'success' | 'failed' | 'stopped';

/**
 * Emitted whenever a run starts or settles, so waiters (the MCP
 * `poll_action_status` tool) can sleep on an event instead of polling the DB.
 */
export interface ActionStatusChangedEvent {
  actionId: number;
  status: ActionStatus;
  exitCode: number | null;
}

@Injectable()
export class ActionsService extends EventEmitter implements OnModuleInit {
  private readonly logger = new Logger('ActionsService');

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly ptyManager: ActionPtyManager,
  ) {
    super();
    // One listener per in-flight waiter (poll_action_status); an agent watching
    // several actions at once must not trip the 10-listener warning.
    this.setMaxListeners(0);
    this.ptyManager.registerPersistence({
      markRunning: (actionId) => this.markRunning(actionId),
      flushCurrentOutput: (actionId, output) =>
        this.flushCurrentOutput(actionId, output),
      finalizeRun: (actionId, payload) => this.finalizeRun(actionId, payload),
    });
  }

  async onModuleInit(): Promise<void> {
    const runningActions = await this.db
      .select()
      .from(schema.actions)
      .where(eq(schema.actions.status, 'running'));

    for (const action of runningActions) {
      if (await this.ptyManager.hasTmuxSessionForAction(action.id)) {
        this.logger.log(
          `Action ${action.id} ("${action.name}") has surviving tmux session, reattaching...`,
        );
        const reattached = await this.ptyManager.reattach(
          action.id,
          action.worktreePath,
        );
        if (reattached) {
          this.logger.log(`Successfully reattached to action ${action.id}`);
          continue;
        }
        this.logger.warn(
          `Failed to reattach to action ${action.id}, marking as stopped`,
        );
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
      .where(
        and(
          eq(schema.actions.worktreePath, worktreePath),
          eq(schema.actions.status, 'running'),
        ),
      );

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

    await this.ptyManager.killTmuxSession(id);

    await this.db.delete(schema.actions).where(eq(schema.actions.id, id));

    return { success: true };
  }

  async run(id: number) {
    const action = await this.findOne(id);
    if (this.ptyManager.isRunning(id) || action.status === 'running') {
      throw new BadRequestException(
        `Action "${action.name}" is already running`,
      );
    }

    try {
      await this.ptyManager.start({
        id: action.id,
        worktreePath: action.worktreePath,
        command: action.command,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === `Action ${action.id} is already running`
      ) {
        throw new BadRequestException(
          `Action "${action.name}" is already running`,
        );
      }

      // The pty never came up, but `start` may already have flipped the row to
      // 'running' — leave it there and every waiter (UI badge, poll_action_status)
      // blocks forever on a run that does not exist. Settle it as failed.
      await this.settleFailedStart(action.id, error).catch(() => undefined);
      throw error;
    }

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

  /**
   * Repair a row left in 'running' by a start that threw. Only touches rows
   * still marked running, so a failure raised before `markRunning` leaves an
   * idle action untouched.
   */
  private async settleFailedStart(
    actionId: number,
    error: unknown,
  ): Promise<void> {
    const rows = await this.db
      .select()
      .from(schema.actions)
      .where(eq(schema.actions.id, actionId));
    if (rows[0]?.status !== 'running') return;

    const message = error instanceof Error ? error.message : String(error);
    const now = new Date().toISOString();
    await this.finalizeRun(actionId, {
      status: 'failed',
      currentOutput: '',
      lastOutput: `Failed to start action: ${message}`,
      lastExitCode: null,
      lastFinishedAt: now,
      updatedAt: now,
    });
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

    this.emitStatusChanged(actionId, 'running', null);
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

  async finalizeRun(
    actionId: number,
    payload: {
      status: ActionStatus;
      currentOutput: string;
      lastOutput: string;
      lastExitCode: number | null;
      lastFinishedAt: string;
      updatedAt: string;
    },
  ): Promise<void> {
    await this.db
      .update(schema.actions)
      .set(payload)
      .where(eq(schema.actions.id, actionId));

    this.emitStatusChanged(actionId, payload.status, payload.lastExitCode);
  }

  /**
   * Emitted only after the row is persisted, so a listener that re-reads the
   * action on the event always sees the final status/exit code.
   */
  private emitStatusChanged(
    actionId: number,
    status: ActionStatus,
    exitCode: number | null,
  ): void {
    const event: ActionStatusChangedEvent = { actionId, status, exitCode };
    this.emit('action-status-changed', event);
  }
}
