import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { execSync, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateTmuxScrollConfig } from './tmux-scroll-config.js';
import { findBinary } from '../config/system-paths.js';

const TMUX_SESSION_PREFIX = 'elevenex';

interface TmuxSession {
  sessionId: number;
  tmuxSessionName: string;
  pid?: number;
}

@Injectable()
export class TmuxManager implements OnModuleDestroy {
  private sessions = new Map<number, TmuxSession>();
  private tmuxAvailable: boolean;
  private tmuxBin: string;
  private scrollBindingsConfigured = false;

  constructor() {
    this.tmuxBin = this.resolveTmuxPath();
    this.tmuxAvailable = this.tmuxBin !== '';
    if (this.tmuxAvailable) {
      console.log(`tmux detected at ${this.tmuxBin} - session persistence enabled`);
    } else {
      console.log('tmux not found - sessions will not persist on reconnect');
    }
  }

  private resolveTmuxPath(): string {
    return findBinary('tmux') ?? '';
  }

  isTmuxAvailable(): boolean {
    return this.tmuxAvailable;
  }

  getTmuxBin(): string {
    return this.tmuxBin;
  }

  /** Configure global tmux key bindings for scroll + auto-exit copy-mode */
  configureScrollBindings(): void {
    if (this.scrollBindingsConfigured) return;

    try {
      const tmpFile = path.join(os.tmpdir(), `elevenex-tmux-scroll-${process.pid}.conf`);
      fs.writeFileSync(tmpFile, generateTmuxScrollConfig());
      execSync(`${this.tmuxBin} source-file ${tmpFile}`, { stdio: 'ignore' });
      fs.unlinkSync(tmpFile);

      this.scrollBindingsConfigured = true;
      console.log('tmux scroll + copy-mode-exit bindings configured');
    } catch (error) {
      console.error('Failed to configure tmux scroll bindings:', error);
    }
  }

  private getSessionName(sessionId: number): string {
    return `${TMUX_SESSION_PREFIX}-${sessionId}`;
  }

  sessionExists(sessionId: number): boolean {
    if (!this.tmuxAvailable) return false;
    
    const sessionName = this.getSessionName(sessionId);
    try {
      execSync(`${this.tmuxBin} has-session -t ${sessionName} 2>/dev/null`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  createSession(sessionId: number, worktreePath: string, claudePath: string): ChildProcess | null {
    if (!this.tmuxAvailable) {
      return null;
    }

    const sessionName = this.getSessionName(sessionId);

    // Kill existing tmux session if any
    this.killSession(sessionId);

    try {
      // Create new tmux session with Claude running inside
      // -d: detached, -s: session name, -c: working directory
      execSync(
        `${this.tmuxBin} new-session -d -s ${sessionName} -c "${worktreePath}" "${claudePath}"`,
        { stdio: 'pipe' }
      );

      // Enable mouse mode so tmux handles scrollback via copy-mode
      execSync(`${this.tmuxBin} set-window-option -t ${sessionName} alternate-screen on`, { stdio: 'ignore' });
      execSync(`${this.tmuxBin} set-option -t ${sessionName} mouse on`, { stdio: 'ignore' });
      execSync(`${this.tmuxBin} set-option -t ${sessionName} history-limit 50000`, { stdio: 'ignore' });
      execSync(`${this.tmuxBin} set-option -t ${sessionName} status off`, { stdio: 'ignore' });

      // Configure global scroll bindings (once, after server is running)
      this.configureScrollBindings();

      this.sessions.set(sessionId, {
        sessionId,
        tmuxSessionName: sessionName,
      });

      // Return a pseudo-process - we'll capture output via tmux pipe
      return this.attachToSession(sessionId);
    } catch (error) {
      console.error(`Failed to create tmux session ${sessionName}:`, error);
      return null;
    }
  }

  attachToSession(sessionId: number): ChildProcess | null {
    if (!this.tmuxAvailable) return null;

    const sessionName = this.getSessionName(sessionId);
    
    if (!this.sessionExists(sessionId)) {
      return null;
    }

    // Enable mouse mode so tmux handles scrollback via copy-mode
    try {
      execSync(`${this.tmuxBin} set-window-option -t ${sessionName} alternate-screen on`, { stdio: 'ignore' });
      execSync(`${this.tmuxBin} set-option -t ${sessionName} mouse on`, { stdio: 'ignore' });
      execSync(`${this.tmuxBin} set-option -t ${sessionName} status off`, { stdio: 'ignore' });
    } catch {
      // Ignore
    }

    // Configure global scroll bindings (once, after server is running)
    this.configureScrollBindings();

    // Attach to tmux session and capture output
    // -C: control mode (for programmatic control)
    // -R: try to resize to fit client
    const proc = spawn(this.tmuxBin, ['attach', '-t', sessionName], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.sessions.set(sessionId, {
      sessionId,
      tmuxSessionName: sessionName,
      pid: proc.pid,
    });

    return proc;
  }

  sendInput(sessionId: number, data: string): void {
    if (!this.tmuxAvailable) return;

    const sessionName = this.getSessionName(sessionId);
    
    try {
      // Send keys to tmux session
      // Use send-keys with literal flag to handle special characters
      execSync(`${this.tmuxBin} send-keys -t ${sessionName} -l "${data.replace(/"/g, '\\"')}"`, { stdio: 'ignore' });
    } catch (error) {
      console.error(`Failed to send input to tmux session ${sessionName}:`, error);
    }
  }

  resize(sessionId: number, cols: number, rows: number): void {
    if (!this.tmuxAvailable) return;

    const sessionName = this.getSessionName(sessionId);
    
    try {
      execSync(`${this.tmuxBin} set-option -t ${sessionName} default-size ${cols}x${rows}`, { stdio: 'ignore' });
      execSync(`${this.tmuxBin} resize-window -t ${sessionName} ${cols} ${rows}`, { stdio: 'ignore' });
    } catch (error) {
      // Ignore resize errors
    }
  }

  killSession(sessionId: number): boolean {
    if (!this.tmuxAvailable) return false;

    const sessionName = this.getSessionName(sessionId);
    
    try {
      execSync(`${this.tmuxBin} kill-session -t ${sessionName} 2>/dev/null`, { stdio: 'ignore' });
      this.sessions.delete(sessionId);
      return true;
    } catch {
      this.sessions.delete(sessionId);
      return false;
    }
  }

  listSessions(): string[] {
    if (!this.tmuxAvailable) return [];

    try {
      const output = execSync(`${this.tmuxBin} list-sessions -F "#{session_name}" 2>/dev/null`, { encoding: 'utf-8' });
      return output.trim().split('\n').filter(s => s.startsWith(`${TMUX_SESSION_PREFIX}-`));
    } catch {
      return [];
    }
  }

  onModuleDestroy(): void {
    // Kill all elevenex tmux sessions on shutdown
    for (const [sessionId] of this.sessions) {
      this.killSession(sessionId);
    }
  }
}