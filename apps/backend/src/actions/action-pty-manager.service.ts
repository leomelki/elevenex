import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleDestroy,
} from '@nestjs/common';
import * as pty from 'node-pty';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildAugmentedEnvAsync,
  buildTmuxInlineEnvPrefix,
  findBinary,
} from '../config/system-paths.js';
import { execFileQuiet } from '../terminal/async-process.js';

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
  completionCheckInFlight?: boolean;
  finalizing?: boolean;
}

interface ActionPersistence {
  markRunning(actionId: number): Promise<void>;
  flushCurrentOutput(actionId: number, output: string): Promise<void>;
  finalizeRun(
    actionId: number,
    payload: {
      status: ActionStatus;
      currentOutput: string;
      lastOutput: string;
      lastExitCode: number | null;
      lastFinishedAt: string;
      updatedAt: string;
    },
  ): Promise<void>;
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
export class ActionPtyManager
  implements OnModuleDestroy, OnApplicationShutdown
{
  private readonly logger = new Logger('ActionPtyManager');
  private readonly processes = new Map<number, RunningAction>();
  private readonly startingActions = new Set<number>();
  private readonly defaultShell = process.env.SHELL || '/bin/zsh';
  private gateway?: ActionGatewayLike;
  private persistence?: ActionPersistence;
  private tmuxBin: string;

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
    if (this.isRunning(action.id) || this.startingActions.has(action.id)) {
      throw new Error(`Action ${action.id} is already running`);
    }

    this.startingActions.add(action.id);

    try {
      if (!(await this.pathExists(action.worktreePath))) {
        throw new Error(`Worktree path does not exist: ${action.worktreePath}`);
      }

      if (!this.persistence) {
        throw new Error('Action persistence is not registered');
      }

      await this.persistence.markRunning(action.id);

      const env = await this.buildEnv(action.worktreePath);

      let ptyProcess: pty.IPty | null = null;

      if (this.isTmuxAvailable()) {
        ptyProcess = await this.spawnWithTmux(action, env);
      }

      if (!ptyProcess) {
        ptyProcess = this.spawnDirect(action, env);
      }

      this.gateway?.notifyStatus(action.id, 'running');
    } finally {
      this.startingActions.delete(action.id);
    }
  }

  async stop(actionId: number): Promise<boolean> {
    const session = this.processes.get(actionId);
    if (!session) return false;

    session.stopRequested = true;

    if (session.useTmux && session.tmuxSessionName) {
      this.stopCompletionMonitor(actionId);

      // Kill tmux session (kills the command inside)
      try {
        await execFileQuiet(this.tmuxBin, [
          'kill-session',
          '-t',
          session.tmuxSessionName,
        ]);
      } catch {
        /* already dead */
      }

      // Kill the tail process
      try {
        session.pty.kill();
      } catch {
        /* ignore */
      }

      // Read final output from log file
      if (session.logFilePath) {
        try {
          session.output = this.trimOutput(
            await fs.readFile(session.logFilePath, 'utf-8'),
          );
        } catch {
          /* ignore */
        }
      }

      // Finalize immediately
      const exitCode = (await this.readExitCode(actionId)) ?? -1;
      await this.handleExit(actionId, exitCode);
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

  async reattach(actionId: number, worktreePath: string): Promise<boolean> {
    const tmuxSessionName = this.getTmuxSessionName(actionId);

    if (!(await this.tmuxSessionExists(tmuxSessionName))) {
      return false;
    }

    this.logger.log(
      `Reattaching to tmux session ${tmuxSessionName} for action ${actionId}`,
    );

    const logFilePath = this.getLogFilePath(actionId);
    const env = await this.buildEnv(worktreePath);

    try {
      // Read existing log content (pipe-pane has been writing since action started)
      let initialOutput = '';
      try {
        initialOutput = this.trimOutput(
          await fs.readFile(logFilePath, 'utf-8'),
        );
      } catch {
        /* log file may not exist if pipe-pane died */
      }

      // Re-start pipe-pane in case it died (idempotent — replaces existing pipe)
      try {
        await execFileQuiet(this.tmuxBin, [
          'pipe-pane',
          '-t',
          tmuxSessionName,
          '-o',
          `cat >> ${this.shellEscape(logFilePath)}`,
        ]);
      } catch {
        /* ignore */
      }

      // Spawn tail to follow only new content (-n 0 = start from current end)
      const ptyProcess = pty.spawn('tail', ['-n', '0', '-f', logFilePath], {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd: worktreePath,
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

      ptyProcess.onExit(() => {
        /* lifecycle handled by completion monitor */
      });

      this.startCompletionMonitor(actionId);

      if (initialOutput) {
        this.scheduleFlush(actionId);
      }

      return true;
    } catch (error) {
      this.logger.error(
        `Failed to reattach to tmux session ${tmuxSessionName}: ${error}`,
      );
      return false;
    }
  }

  hasTmuxSessionForAction(actionId: number): Promise<boolean> {
    return this.tmuxSessionExists(this.getTmuxSessionName(actionId));
  }

  async killTmuxSession(actionId: number): Promise<void> {
    if (!this.isTmuxAvailable()) return;
    const tmuxSessionName = this.getTmuxSessionName(actionId);
    try {
      await execFileQuiet(this.tmuxBin, [
        'kill-session',
        '-t',
        tmuxSessionName,
      ]);
    } catch {
      // Session may not exist
    }
    // Clean up associated files
    await fs.unlink(this.getLogFilePath(actionId)).catch(() => undefined);
    await fs.unlink(this.getExitCodePath(actionId)).catch(() => undefined);
  }

  // --- tmux infrastructure ---

  private resolveTmuxPath(): string {
    return findBinary('tmux') ?? '';
  }

  private isTmuxAvailable(): boolean {
    if (this.tmuxBin === '') {
      this.tmuxBin = this.resolveTmuxPath();
    }
    return this.tmuxBin !== '';
  }

  private getTmuxSessionName(actionId: number): string {
    return `${TMUX_SESSION_PREFIX}-${actionId}`;
  }

  private async tmuxSessionExists(tmuxSessionName: string): Promise<boolean> {
    if (!this.isTmuxAvailable()) return false;
    try {
      await execFileQuiet(this.tmuxBin, ['has-session', '-t', tmuxSessionName]);
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

  private async readExitCode(actionId: number): Promise<number | null> {
    const exitCodePath = this.getExitCodePath(actionId);
    try {
      const content = (await fs.readFile(exitCodePath, 'utf-8')).trim();
      await fs.unlink(exitCodePath).catch(() => undefined);
      const code = parseInt(content, 10);
      return Number.isFinite(code) ? code : null;
    } catch {
      return null;
    }
  }

  private shellEscape(cmd: string): string {
    return `'${cmd.replace(/'/g, "'\\''")}'`;
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private async buildEnv(worktreePath?: string): Promise<NodeJS.ProcessEnv> {
    return {
      ...(await buildAugmentedEnvAsync(process.env, worktreePath)),
      ...(worktreePath ? { PWD: worktreePath } : {}),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };
  }

  private resolveShell(env: NodeJS.ProcessEnv): string {
    return env.SHELL || this.defaultShell;
  }

  // --- spawn methods ---

  private async spawnWithTmux(
    action: ActionRecord,
    env: NodeJS.ProcessEnv,
  ): Promise<pty.IPty | null> {
    const tmuxSessionName = this.getTmuxSessionName(action.id);
    const logFilePath = this.getLogFilePath(action.id);
    const exitCodePath = this.getExitCodePath(action.id);

    try {
      // Actions always start fresh — kill any stale session
      if (await this.tmuxSessionExists(tmuxSessionName)) {
        await execFileQuiet(this.tmuxBin, [
          'kill-session',
          '-t',
          tmuxSessionName,
        ]);
      }

      // Clean up stale files
      await fs.unlink(logFilePath).catch(() => undefined);
      await fs.unlink(exitCodePath).catch(() => undefined);

      // Create empty log file so tail can start immediately
      await fs.writeFile(logFilePath, '');

      // Wrap command to capture exit code before tmux session dies. Prefix
      // with PATH / version-manager env so the user's command resolves to the
      // worktree-pinned node — the running tmux server's stale env would
      // otherwise win (its env was captured at server startup). Inline the
      // full augmented env, not only PATH, so action commands see the same
      // tokens and tool variables as non-tmux executions.
      const tmuxEnvPrefix = buildTmuxInlineEnvPrefix(env, { mode: 'full' });
      const shell = this.resolveShell(env);
      const innerCmd = `${tmuxEnvPrefix} ${this.shellEscape(shell)} -lc ${this.shellEscape(action.command)}; echo $? > ${this.shellEscape(exitCodePath)}`;

      await execFileQuiet(
        this.tmuxBin,
        [
          'new-session',
          '-d',
          '-s',
          tmuxSessionName,
          '-c',
          action.worktreePath,
          '-x',
          '120',
          '-y',
          '32',
          `/bin/sh -c ${this.shellEscape(innerCmd)}`,
        ],
        {
          env: { ...env, TERM: 'xterm-256color' },
        },
      );

      await execFileQuiet(this.tmuxBin, [
        'set-option',
        '-t',
        tmuxSessionName,
        'status',
        'off',
      ]);
      await execFileQuiet(this.tmuxBin, [
        'set-option',
        '-t',
        tmuxSessionName,
        'history-limit',
        '50000',
      ]);

      // Pipe pane output to log file (raw command output, no tmux wrapping)
      await execFileQuiet(this.tmuxBin, [
        'pipe-pane',
        '-t',
        tmuxSessionName,
        '-o',
        `cat >> ${this.shellEscape(logFilePath)}`,
      ]);

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

      ptyProcess.onExit(() => {
        /* lifecycle handled by completion monitor */
      });

      // Poll for tmux session death to detect command completion
      this.startCompletionMonitor(action.id);

      return ptyProcess;
    } catch (error) {
      this.logger.error(
        `Failed to create tmux session ${tmuxSessionName}: ${error}`,
      );
      return null;
    }
  }

  private spawnDirect(action: ActionRecord, env: NodeJS.ProcessEnv): pty.IPty {
    const ptyProcess = pty.spawn(
      this.resolveShell(env),
      ['-lc', action.command],
      {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd: action.worktreePath,
        env,
      },
    );

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
      const current = this.processes.get(actionId);
      if (!current || current.completionCheckInFlight) return;

      current.completionCheckInFlight = true;
      void this.tmuxSessionExists(tmuxSessionName)
        .then((exists) => {
          if (!exists) {
            this.stopCompletionMonitor(actionId);
            void this.handleTmuxCompletion(actionId);
          }
        })
        .finally(() => {
          const latest = this.processes.get(actionId);
          if (latest) {
            latest.completionCheckInFlight = false;
          }
        });
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
    try {
      session.pty.kill();
    } catch {
      /* ignore */
    }

    // Read final output from the log file (clean, no tmux artifacts)
    if (session.logFilePath) {
      try {
        session.output = this.trimOutput(
          await fs.readFile(session.logFilePath, 'utf-8'),
        );
      } catch {
        /* keep accumulated output */
      }
      await fs.unlink(session.logFilePath).catch(() => undefined);
    }

    const exitCode = (await this.readExitCode(actionId)) ?? -1;
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
    if (session.finalizing) return;
    session.finalizing = true;

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
