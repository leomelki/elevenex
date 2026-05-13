import { BadRequestException, Injectable, forwardRef, Inject } from '@nestjs/common';
import { SessionsService } from '../sessions/sessions.service.js';
import { PtyManager } from './pty-manager.service.js';
import * as fs from 'fs';

@Injectable()
export class TerminalService {
  constructor(
    @Inject(forwardRef(() => SessionsService)) private readonly sessionsService: SessionsService,
    @Inject(forwardRef(() => PtyManager)) private readonly ptyManager: PtyManager,
  ) {}

  async startSession(sessionId: number): Promise<{ success: boolean; resumed: boolean; error?: string }> {
    const session = await this.sessionsService.findOne(sessionId);

    if (session.status === 'archived') {
      throw new BadRequestException('Archived sessions cannot be started');
    }

    // Verify worktree path exists
    if (!fs.existsSync(session.worktreePath)) {
      return { 
        success: false, 
        resumed: false, 
        error: `Worktree path does not exist: ${session.worktreePath}` 
      };
    }

    // Check if PTY is already running for this session
    if (this.ptyManager.isAlive(sessionId)) {
      console.log(`PTY already running for session ${sessionId}, reusing`);
      await this.sessionsService.updateStatus(sessionId, 'active');
      return { success: true, resumed: true };
    }

    // Check if tmux session exists (we can reattach)
    if (this.ptyManager.hasTmuxSession(sessionId)) {
      console.log(`Found existing tmux session for ${sessionId}, reattaching`);
      try {
        this.ptyManager.spawn(sessionId, session.worktreePath);
        await this.sessionsService.updateStatus(sessionId, 'active');
        return { success: true, resumed: true };
      } catch (error) {
        console.error(`Failed to reattach to tmux session ${sessionId}:`, error);
        // Fall through to create new session
      }
    }

    const claudeSessionId = session.claudeSessionId;

    // Check if we have a valid Claude session ID to resume
    if (claudeSessionId && claudeSessionId !== '-1') {
      try {
        this.ptyManager.spawn(sessionId, session.worktreePath, claudeSessionId);

        // Wait a bit to see if the process exits immediately (invalid session ID)
        await new Promise(resolve => setTimeout(resolve, 500));

        if (this.ptyManager.isAlive(sessionId)) {
          await this.sessionsService.updateStatus(sessionId, 'active');
          return { success: true, resumed: true };
        }

        // Process exited - resume failed, start fresh
        console.log(`Resume failed for session ${sessionId}, starting fresh`);
      } catch (error) {
        console.log(`Resume error for session ${sessionId}:`, error);
      }
    }

    // Start fresh session
    try {
      this.ptyManager.spawn(sessionId, session.worktreePath);
      await this.sessionsService.updateStatus(sessionId, 'active');
      return { success: true, resumed: false };
    } catch (error) {
      console.error(`Failed to spawn PTY for session ${sessionId}:`, error);
      return { success: false, resumed: false, error: String(error) };
    }
  }

  async stopSession(sessionId: number): Promise<{ success: boolean }> {
    const killed = this.ptyManager.kill(sessionId);
    if (killed) {
      await this.sessionsService.updateStatus(sessionId, 'stopped');
    }
    return { success: killed };
  }
}
