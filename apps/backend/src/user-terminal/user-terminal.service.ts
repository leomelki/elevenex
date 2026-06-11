import {
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
  Logger,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { UserPtyManager } from './user-pty-manager.service.js';
import { getDefaultUserShell } from '../config/system-paths.js';
import { promises as fs } from 'fs';
import * as path from 'path';

@Injectable()
export class UserTerminalService {
  private readonly logger = new Logger('UserTerminalService');
  private readonly defaultShell = getDefaultUserShell();
  private readonly startInFlight = new Map<
    number,
    Promise<{ success: boolean; error?: string }>
  >();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(forwardRef(() => UserPtyManager))
    private readonly ptyManager: UserPtyManager,
  ) {}

  async create(dto: { worktreePath: string; name?: string }) {
    const shell = this.defaultShell;
    const name = dto.name || path.basename(shell);

    const rows = await this.db
      .insert(schema.userTerminals)
      .values({
        worktreePath: dto.worktreePath,
        name,
        shell,
      })
      .returning();

    return rows[0];
  }

  async listByWorktree(worktreePath: string) {
    return this.db
      .select()
      .from(schema.userTerminals)
      .where(eq(schema.userTerminals.worktreePath, worktreePath))
      .orderBy(schema.userTerminals.createdAt);
  }

  async findOne(id: number) {
    const rows = await this.db
      .select()
      .from(schema.userTerminals)
      .where(eq(schema.userTerminals.id, id));

    if (rows.length === 0) {
      throw new NotFoundException(`User terminal ${id} not found`);
    }
    return rows[0];
  }

  async rename(id: number, name: string) {
    const existing = await this.findOne(id);
    await this.db
      .update(schema.userTerminals)
      .set({ name })
      .where(eq(schema.userTerminals.id, id));
    return { ...existing, name };
  }

  async remove(id: number) {
    await this.findOne(id); // Throws if not found
    await this.ptyManager.destroy(id);
    await this.db
      .delete(schema.userTerminals)
      .where(eq(schema.userTerminals.id, id));
    return { success: true };
  }

  async startTerminal(
    terminalId: number,
  ): Promise<{ success: boolean; error?: string }> {
    const inFlight = this.startInFlight.get(terminalId);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.startTerminalInternal(terminalId).finally(() => {
      if (this.startInFlight.get(terminalId) === promise) {
        this.startInFlight.delete(terminalId);
      }
    });
    this.startInFlight.set(terminalId, promise);
    return promise;
  }

  private async startTerminalInternal(
    terminalId: number,
  ): Promise<{ success: boolean; error?: string }> {
    const terminal = await this.findOne(terminalId);

    // Verify worktree path exists
    try {
      await fs.access(terminal.worktreePath);
    } catch {
      return {
        success: false,
        error: `Worktree path does not exist: ${terminal.worktreePath}`,
      };
    }

    // Check if PTY is already running
    if (this.ptyManager.isAlive(terminalId)) {
      this.logger.log(
        `PTY already running for terminal ${terminalId}, reusing`,
      );
      return { success: true };
    }

    // Spawn (handles both fresh create and tmux reattach internally)
    try {
      const spawned = await this.ptyManager.spawn(
        terminalId,
        terminal.worktreePath,
        terminal.shell,
      );
      if (spawned === null) {
        return { success: false, error: 'Terminal start was cancelled' };
      }
      return { success: true };
    } catch (error) {
      this.logger.error(
        `Failed to spawn PTY for terminal ${terminalId}: ${error}`,
      );
      return { success: false, error: String(error) };
    }
  }
}
