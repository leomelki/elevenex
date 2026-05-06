import { Injectable, Logger, OnApplicationShutdown, OnModuleDestroy } from '@nestjs/common';
import * as pty from 'node-pty';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { buildAugmentedEnv, findBinary } from '../config/system-paths.js';

type ActionStatus = 'idle' | 'running' | 'success' | 'failed' | 'stopped';

interface ActionRecord {
  id: number;
  worktreePath: string;
  command: string;
}

interface RunningAction {
  id: number;
  pty: pty.IPty;
  output: string;
  flushTimer: NodeJS.Timeout | null;
  stopRequested: boolean;
  useTmux: boolean;
  tmuxSessionName?: string;
  logFilePath?: string;
  completionMonitor?: NodeJS.Timeout;
}

interface ActionPersistence {
  markRunning(actionId: number): Promise<void>;
  flushCurrentOutput(actionId: number, output: string): Promise<void>;
  finalizeRun(actionId: number, payload: {
    status: ActionStatus;
    currentOutput: string;
    lastOutput: string;
    lastExitCode: number | null;
    lastFinishedAt: string;
    updatedAt: string;
  }): Promise<void>;
}

interface ActionGatewayLike {
  sendToAction(actionId: number, data: Buffer | string): void;
  notifyStatus(actionId: number, status: ActionStatus): void;
}

const MAX_OUTPUT_CHARS = 50_000;
const FLUSH_DEBOUNCE_MS = 250;
const TMUX_SESSION_PREFIX = 'elevenex-action';
const COMPLETION_POLL_MS = 300;

@Injectable()
export class ActionPtyManager implements OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger('ActionPtyManager');
  private readonly processes = new Map<number, RunningAction>();
  private readonly defaultShell = process.env.SHELL || '/bin/zsh';
  private gateway?: ActionGatewayLike;
  private persistence?: ActionPersistence;
  private readonly tmuxBin: string;

  constructor() {
    this.tmuxBin = this.resolveTmuxPath();
  }

  registerGateway(gateway: ActionGatewayLike): void {
    this.gateway = gateway;
  }

  registerPersistence(persistence: ActionPersistence): void {
    this.persistence = persistence;
  }

  isRunning(actionId: number): boolean {
    return this.processes.has(actionId);
  }

  getCurrentOutput(actionId: number): string {
    return this.processes.get(actionId)?.output ?? '';
  }

  async start(action: ActionRecord): Promise<void> {
    if (this.isRunning(action.id)) {
      throw new Error(`Action ${action.id} is already running`);
    }

    if (!fs.existsSync(action.worktreePath)) {
      throw new Error(`Worktree path does not exist: ${action.worktreePath}`);
    }

    if (!this.persistence) {
      throw new Error('Action persistence is not registered');
    }

    await this.persistence.markRunning(action.id);

    const env = this.buildEnv(action.worktreePath);

    let ptyProcess: pty.IPty | null = null;

    if (this.isTmuxAvailable()) {
      ptyProcess = this.spawnWithTmux(action, env);
    }

    if (!ptyProcess) {
      ptyProcess = this.spawnDirect(action, env);
    }

    this.gateway?.notifyStatus(action.id, 'running');
  }

  async stop(actionId: number): Promise<boolean> {
    const session = this.processes.get(actionId);
    if (!session) return false;

    session.stopRequested = true;

    if (session.useTmux && session.tmuxSessionName) {
      this.stopCompletionMonitor(actionId);

      // Kill tmux session (kills the command inside)
      try {
        execSync(`${this.tmuxBin} kill-session -t ${session.tmuxSessionName} 2>/dev/null`, { stdio: 'ignore' });
      } catch { /* already dead */ }

      // Kill the tail process
      try { session.pty.kill(); } catch { /* ignore */ }

      // Read final output from log file
      if (session.logFilePath) {
        try {
          session.output = this.trimOutput(fs.readFileSync(session.logFilePath, 'utf-8'));
        } catch { /* ignore */ }
      }

      // Finalize immediately
      const exitCode = this.readExitCode(actionId) ?? -1;
      void this.handleExit(actionId, exitCode);
    } else {
      session.pty.kill('SIGTERM');

      setTimeout(() => {
        const current = this.processes.get(actionId);
        if (!current) return;
        try {
          current.pty.kill('SIGKILL');
        } catch {
          // Ignore: process already exited.
        }
      }, 1500);
    }

    return true;
  }

  async reattach(actionId: number): Promise<boolean> {
    const tmuxSessionName = this.getTmuxSessionName(actionId);

    if (!this.tmuxSessionExists(tmuxSessionName)) {
      return false;
    }

    this.logger.log(`Reattaching to tmux session ${tmuxSessionName} for action ${actionId}`);

    const logFilePath = this.getLogFilePath(actionId);
    const env = this.buildEnv();

    try {
      // Read existing log content (pipe-pane has been writing since action started)
      let initialOutput = '';
      try {
        initialOutput = this.trimOutput(fs.readFileSync(logFilePath, 'utf-8'));
      } catch { /* log file may not exist if pipe-pane died */ }

      // Re-start pipe-pane in case it died (idempotent — replaces existing pipe)
      try {
        execSync(`${this.tmuxBin} pipe-pane -t ${tmuxSessionName} -o 'cat >> ${logFilePath}'`, { stdio: 'ignore' });
      } catch { /* ignore */ }

      // Spawn tail to follow only new content (-n 0 = start from current end)
      const ptyProcess = pty.spawn('tail', ['-n', '0', '-f', logFilePath], {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd: env.PWD || process.cwd(),
        env,
      });

      const running: RunningAction = {
        id: actionId,
        pty: ptyProcess,
        output: initialOutput,
        flushTimer: null,
        stopRequested: false,
        useTmux: true,
        tmuxSessionName,
        logFilePath,
      };

      this.processes.set(actionId, running);

      ptyProcess.onData((data) => {
        const session = this.processes.get(actionId);
        if (!session) return;
        session.output = this.trimOutput(session.output + data);
        this.gateway?.sendToAction(actionId, data);
        this.scheduleFlush(actionId);
      });

      ptyProcess.onExit(() => { /* lifecycle handled by completion monitor */ });

      this.startCompletionMonitor(actionId);

      if (initialOutput) {
        this.scheduleFlush(actionId);
      }

      return true;
    } catch (error) {
      this.logger.error(`Failed to reattach to tmux session ${tmuxSessionName}: ${error}`);
      return false;
    }
  }

  hasTmuxSessionForAction(actionId: number): boolean {
    return this.tmuxSessionExists(this.getTmuxSessionName(actionId));
  }

  killTmuxSession(actionId: number): void {
    if (!this.isTmuxAvailable()) return;
    const tmuxSessionName = this.getTmuxSessionName(actionId);
    try {
      execSync(`${this.tmuxBin} kill-session -t ${tmuxSessionName} 2>/dev/null`, { stdio: 'ignore' });
    } catch {
      // Session may not exist
    }
    // Clean up associated files
    try { fs.unlinkSync(this.getLogFilePath(actionId)); } catch { /* ignore */ }
    try { fs.unlinkSync(this.getExitCodePath(actionId)); } catch { /* ignore */ }
  }

  // --- tmux infrastructure ---

  private resolveTmuxPath(): string {
    return findBinary('tmux') ?? '';
  }

  private isTmuxAvailable(): boolean {
    return this.tmuxBin !== '';
  }

  private getTmuxSessionName(actionId: number): string {
    return `${TMUX_SESSION_PREFIX}-${actionId}`;
  }

  private tmuxSessionExists(tmuxSessionName: string): boolean {
    if (!this.isTmuxAvailable()) return false;
    try {
      execSync(`${this.tmuxBin} has-session -t ${tmuxSessionName} 2>/dev/null`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  private getExitCodePath(actionId: number): string {
    return path.join(os.tmpdir(), `elevenex-action-${actionId}.exitcode`);
  }

  private getLogFilePath(actionId: number): string {
    return path.join(os.tmpdir(), `elevenex-action-${actionId}.log`);
  }

  private readExitCode(actionId: number): number | null {
    const exitCodePath = this.getExitCodePath(actionId);
    try {
      const content = fs.readFileSync(exitCodePath, 'utf-8').trim();
      fs.unlinkSync(exitCodePath);
      const code = parseInt(content, 10);
      return Number.isFinite(code) ? code : null;
    } catch {
      return null;
    }
  }

  private shellEscape(cmd: string): string {
    return `'${cmd.replace(/'/g, "'\\''")}'`;
  }

  private buildEnv(worktreePath?: string): NodeJS.ProcessEnv {
    return {
      ...buildAugmentedEnv(process.env, worktreePath),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };
  }

  // --- spawn methods ---

  private spawnWithTmux(
    action: ActionRecord,
    env: NodeJS.ProcessEnv,
  ): pty.IPty | null {
    const tmuxSessionName = this.getTmuxSessionName(action.id);
    const logFilePath = this.getLogFilePath(action.id);
    const exitCodePath = this.getExitCodePath(action.id);

    try {
      // Actions always start fresh — kill any stale session
      if (this.tmuxSessionExists(tmuxSessionName)) {
        execSync(`${this.tmuxBin} kill-session -t ${tmuxSessionName} 2>/dev/null`, { stdio: 'ignore' });
      }

      // Clean up stale files
      try { fs.unlinkSync(logFilePath); } catch { /* ignore */ }
      try { fs.unlinkSync(exitCodePath); } catch { /* ignore */ }

      // Create empty log file so tail can start immediately
      fs.writeFileSync(logFilePath, '');

      // Wrap command to capture exit code before tmux session dies
      const innerCmd = `${this.defaultShell} -lc ${this.shellEscape(action.command)}; echo $? > ${this.shellEscape(exitCodePath)}`;

      execSync(
        `${this.tmuxBin} new-session -d -s ${tmuxSessionName} -c "${action.worktreePath}" -x 120 -y 32 /bin/sh -c ${this.shellEscape(innerCmd)}`,
        {
          stdio: 'pipe',
          env: { ...env, TERM: 'xterm-256color' },
        },
      );

      execSync(`${this.tmuxBin} set-option -t ${tmuxSessionName} status off`, { stdio: 'ignore' });
      execSync(`${this.tmuxBin} set-option -t ${tmuxSessionName} history-limit 50000`, { stdio: 'ignore' });

      // Pipe pane output to log file (raw command output, no tmux wrapping)
      execSync(`${this.tmuxBin} pipe-pane -t ${tmuxSessionName} -o 'cat >> ${logFilePath}'`, { stdio: 'ignore' });

      // Tail the log file for live streaming (instead of tmux attach)
      // This gives xterm.js clean output with proper scrollback
      const ptyProcess = pty.spawn('tail', ['-f', logFilePath], {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd: action.worktreePath,
        env,
      });

      const running: RunningAction = {
        id: action.id,
        pty: ptyProcess,
        output: '',
        flushTimer: null,
        stopRequested: false,
        useTmux: true,
        tmuxSessionName,
        logFilePath,
      };

      this.processes.set(action.id, running);

      ptyProcess.onData((data) => {
        const session = this.processes.get(action.id);
        if (!session) return;
        session.output = this.trimOutput(session.output + data);
        this.gateway?.sendToAction(action.id, data);
        this.scheduleFlush(action.id);
      });

      ptyProcess.onExit(() => { /* lifecycle handled by completion monitor */ });

      // Poll for tmux session death to detect command completion
      this.startCompletionMonitor(action.id);

      return ptyProcess;
    } catch (error) {
      this.logger.error(`Failed to create tmux session ${tmuxSessionName}: ${error}`);
      return null;
    }
  }

  private spawnDirect(action: ActionRecord, env: NodeJS.ProcessEnv): pty.IPty {
    const ptyProcess = pty.spawn(this.defaultShell, ['-lc', action.command], {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd: action.worktreePath,
      env,
    });

    const running: RunningAction = {
      id: action.id,
      pty: ptyProcess,
      output: '',
      flushTimer: null,
      stopRequested: false,
      useTmux: false,
    };

    this.processes.set(action.id, running);

    ptyProcess.onData((data) => {
      const session = this.processes.get(action.id);
      if (!session) return;
      session.output = this.trimOutput(session.output + data);
      this.gateway?.sendToAction(action.id, data);
      this.scheduleFlush(action.id);
    });

    ptyProcess.onExit(({ exitCode }) => {
      void this.handleExit(action.id, exitCode);
    });

    return ptyProcess;
  }

  // --- output & lifecycle ---

  private startCompletionMonitor(actionId: number): void {
    const session = this.processes.get(actionId);
    if (!session?.tmuxSessionName) return;

    const tmuxSessionName = session.tmuxSessionName;

    session.completionMonitor = setInterval(() => {
      if (!this.tmuxSessionExists(tmuxSessionName)) {
        this.stopCompletionMonitor(actionId);
        void this.handleTmuxCompletion(actionId);
      }
    }, COMPLETION_POLL_MS);
  }

  private stopCompletionMonitor(actionId: number): void {
    const session = this.processes.get(actionId);
    if (session?.completionMonitor) {
      clearInterval(session.completionMonitor);
      session.completionMonitor = undefined;
    }
  }

  private async handleTmuxCompletion(actionId: number): Promise<void> {
    const session = this.processes.get(actionId);
    if (!session) return;

    // Kill the tail process
    try { session.pty.kill(); } catch { /* ignore */ }

    // Read final output from the log file (clean, no tmux artifacts)
    if (session.logFilePath) {
      try {
        session.output = this.trimOutput(fs.readFileSync(session.logFilePath, 'utf-8'));
      } catch { /* keep accumulated output */ }
      try { fs.unlinkSync(session.logFilePath); } catch { /* ignore */ }
    }

    const exitCode = this.readExitCode(actionId) ?? -1;
    await this.handleExit(actionId, exitCode);
  }

  private scheduleFlush(actionId: number): void {
    const session = this.processes.get(actionId);
    if (!session || session.flushTimer) return;

    session.flushTimer = setTimeout(() => {
      session.flushTimer = null;
      void this.flushCurrentOutput(actionId);
    }, FLUSH_DEBOUNCE_MS);
  }

  private async flushCurrentOutput(actionId: number): Promise<void> {
    const session = this.processes.get(actionId);
    if (!session || !this.persistence) return;
    await this.persistence.flushCurrentOutput(actionId, session.output);
  }

  private async handleExit(actionId: number, exitCode: number): Promise<void> {
    const session = this.processes.get(actionId);
    if (!session || !this.persistence) return;

    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }

    const now = new Date().toISOString();
    const lastOutput = session.output;
    const status: ActionStatus = session.stopRequested
      ? 'stopped'
      : exitCode === 0
        ? 'success'
        : 'failed';

    await this.persistence.finalizeRun(actionId, {
      status,
      currentOutput: '',
      lastOutput,
      lastExitCode: Number.isFinite(exitCode) ? exitCode : null,
      lastFinishedAt: now,
      updatedAt: now,
    });

    this.processes.delete(actionId);
    this.gateway?.notifyStatus(actionId, status);
  }

  private trimOutput(output: string): string {
    if (output.length <= MAX_OUTPUT_CHARS) return output;
    return output.slice(output.length - MAX_OUTPUT_CHARS);
  }

  onModuleDestroy(): void {
    // Kill tail processes and monitors — tmux sessions survive for reattach after restart
    for (const [, session] of this.processes) {
      if (session.completionMonitor) {
        clearInterval(session.completionMonitor);
      }
      if (session.flushTimer) {
        clearTimeout(session.flushTimer);
      }
      // Flush final output
      if (session.output && this.persistence) {
        void this.persistence.flushCurrentOutput(session.id, session.output);
      }
      try {
        session.pty.kill();
      } catch {
        // Ignore
      }
    }
    this.processes.clear();
  }

  onApplicationShutdown(): void {
    this.onModuleDestroy();
  }
}
