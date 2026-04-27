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
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class UserTerminalService {
  private readonly logger = new Logger('UserTerminalService');
  private readonly defaultShell = process.env.SHELL || '/bin/zsh';

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(forwardRef(() => UserPtyManager)) private readonly ptyManager: UserPtyManager,
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
    this.ptyManager.destroy(id);
    await this.db
      .delete(schema.userTerminals)
      .where(eq(schema.userTerminals.id, id));
    return { success: true };
  }

  async startTerminal(terminalId: number): Promise<{ success: boolean; error?: string }> {
    const terminal = await this.findOne(terminalId);

    // Verify worktree path exists
    if (!fs.existsSync(terminal.worktreePath)) {
      return {
        success: false,
        error: `Worktree path does not exist: ${terminal.worktreePath}`,
      };
    }

    // Check if PTY is already running
    if (this.ptyManager.isAlive(terminalId)) {
      this.logger.log(`PTY already running for terminal ${terminalId}, reusing`);
      return { success: true };
    }

    // Spawn (handles both fresh create and tmux reattach internally)
    try {
      this.ptyManager.spawn(terminalId, terminal.worktreePath, terminal.shell);
      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to spawn PTY for terminal ${terminalId}: ${error}`);
      return { success: false, error: String(error) };
    }
  }
}
