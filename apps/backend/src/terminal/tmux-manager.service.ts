import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateTmuxScrollConfig } from './tmux-scroll-config.js';
import { findBinary } from '../config/system-paths.js';
import { execFileAsync, execFileQuiet } from './async-process.js';

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
  private scrollBindingsConfigurePromise: Promise<void> | null = null;

  constructor() {
    this.tmuxBin = this.resolveTmuxPath();
    this.tmuxAvailable = this.tmuxBin !== '';
    if (this.tmuxAvailable) {
      console.log(
        `tmux detected at ${this.tmuxBin} - session persistence enabled`,
      );
    } else {
      console.log('tmux not found - sessions will not persist on reconnect');
    }
  }

  private resolveTmuxPath(): string {
    return findBinary('tmux') ?? '';
  }

  private refreshTmuxPath(): void {
    if (this.tmuxAvailable) return;
    const resolved = this.resolveTmuxPath();
    if (!resolved) return;

    this.tmuxBin = resolved;
    this.tmuxAvailable = true;
    console.log(
      `tmux detected at ${this.tmuxBin} - session persistence enabled`,
    );
  }

  isTmuxAvailable(): boolean {
    this.refreshTmuxPath();
    return this.tmuxAvailable;
  }

  getTmuxBin(): string {
    this.refreshTmuxPath();
    return this.tmuxBin;
  }

  /** Configure global tmux key bindings for scroll + auto-exit copy-mode */
  async configureScrollBindings(): Promise<void> {
    if (this.scrollBindingsConfigured) return;
    if (this.scrollBindingsConfigurePromise) {
      return this.scrollBindingsConfigurePromise;
    }

    const tmpFile = path.join(
      os.tmpdir(),
      `elevenex-tmux-scroll-${process.pid}.conf`,
    );
    this.scrollBindingsConfigurePromise = (async () => {
      try {
        await fs.writeFile(tmpFile, generateTmuxScrollConfig());
        await execFileQuiet(this.tmuxBin, ['source-file', tmpFile]);
        await fs.unlink(tmpFile).catch(() => undefined);

        this.scrollBindingsConfigured = true;
        console.log('tmux scroll + copy-mode-exit bindings configured');
      } catch (error) {
        await fs.unlink(tmpFile).catch(() => undefined);
        console.error('Failed to configure tmux scroll bindings:', error);
      } finally {
        this.scrollBindingsConfigurePromise = null;
      }
    })();
    return this.scrollBindingsConfigurePromise;
  }

  private getSessionName(sessionId: number): string {
    return `${TMUX_SESSION_PREFIX}-${sessionId}`;
  }

  async sessionExists(sessionId: number): Promise<boolean> {
    if (!this.tmuxAvailable) return false;

    const sessionName = this.getSessionName(sessionId);
    try {
      await execFileQuiet(this.tmuxBin, ['has-session', '-t', sessionName]);
      return true;
    } catch {
      return false;
    }
  }

  async createSession(
    sessionId: number,
    worktreePath: string,
    claudePath: string,
  ): Promise<ChildProcess | null> {
    if (!this.tmuxAvailable) {
      return null;
    }

    const sessionName = this.getSessionName(sessionId);

    // Kill existing tmux session if any
    await this.killSession(sessionId);

    try {
      // Create new tmux session with Claude running inside
      // -d: detached, -s: session name, -c: working directory
      await execFileQuiet(this.tmuxBin, [
        'new-session',
        '-d',
        '-s',
        sessionName,
        '-c',
        worktreePath,
        claudePath,
      ]);

      // Enable mouse mode so tmux handles scrollback via copy-mode
      await this.configureSessionOptions(sessionName, true);

      // Configure global scroll bindings (once, after server is running)
      await this.configureScrollBindings();

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

  async attachToSession(sessionId: number): Promise<ChildProcess | null> {
    if (!this.tmuxAvailable) return null;

    const sessionName = this.getSessionName(sessionId);

    if (!(await this.sessionExists(sessionId))) {
      return null;
    }

    // Enable mouse mode so tmux handles scrollback via copy-mode
    try {
      await this.configureSessionOptions(sessionName, false);
    } catch {
      // Ignore
    }

    // Configure global scroll bindings (once, after server is running)
    await this.configureScrollBindings();

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

    // Send keys to tmux session. Keep this fire-and-forget so terminal input
    // never blocks the Node event loop behind tmux process startup.
    void execFileQuiet(this.tmuxBin, [
      'send-keys',
      '-t',
      sessionName,
      '-l',
      data,
    ]).catch((error) => {
      console.error(
        `Failed to send input to tmux session ${sessionName}:`,
        error,
      );
    });
  }

  resize(sessionId: number, cols: number, rows: number): void {
    if (!this.tmuxAvailable) return;

    const sessionName = this.getSessionName(sessionId);

    void this.resizeWindow(sessionName, cols, rows).catch(() => {
      // Ignore resize errors
    });
  }

  async killSession(sessionId: number): Promise<boolean> {
    if (!this.tmuxAvailable) return false;

    const sessionName = this.getSessionName(sessionId);

    try {
      await execFileQuiet(this.tmuxBin, ['kill-session', '-t', sessionName]);
      this.sessions.delete(sessionId);
      return true;
    } catch {
      this.sessions.delete(sessionId);
      return false;
    }
  }

  async listSessions(): Promise<string[]> {
    if (!this.tmuxAvailable) return [];

    try {
      const { stdout } = await execFileAsync(this.tmuxBin, [
        'list-sessions',
        '-F',
        '#{session_name}',
      ]);
      return stdout
        .trim()
        .split('\n')
        .filter((s) => s.startsWith(`${TMUX_SESSION_PREFIX}-`));
    } catch {
      return [];
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Kill all elevenex tmux sessions on shutdown
    for (const [sessionId] of this.sessions) {
      await this.killSession(sessionId);
    }
  }

  private async configureSessionOptions(
    sessionName: string,
    includeHistoryLimit: boolean,
  ): Promise<void> {
    await execFileQuiet(this.tmuxBin, [
      'set-window-option',
      '-t',
      sessionName,
      'alternate-screen',
      'on',
    ]);
    await execFileQuiet(this.tmuxBin, [
      'set-option',
      '-t',
      sessionName,
      'mouse',
      'on',
    ]);
    if (includeHistoryLimit) {
      await execFileQuiet(this.tmuxBin, [
        'set-option',
        '-t',
        sessionName,
        'history-limit',
        '50000',
      ]);
    }
    await execFileQuiet(this.tmuxBin, [
      'set-option',
      '-t',
      sessionName,
      'status',
      'off',
    ]);
  }

  private async resizeWindow(
    sessionName: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    await execFileQuiet(this.tmuxBin, [
      'set-option',
      '-t',
      sessionName,
      'default-size',
      `${cols}x${rows}`,
    ]);
    await execFileQuiet(this.tmuxBin, [
      'resize-window',
      '-t',
      sessionName,
      String(cols),
      String(rows),
    ]);
  }
}
