import {
  Injectable,
  OnModuleDestroy,
  OnApplicationShutdown,
  Inject,
  forwardRef,
  Logger,
} from '@nestjs/common';
import * as pty from 'node-pty';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UserTerminalGateway } from './user-terminal.gateway.js';
import { generateTmuxScrollConfig } from '../terminal/tmux-scroll-config.js';
import { buildAugmentedEnvAsync, findBinary } from '../config/system-paths.js';
import { execFileQuiet } from '../terminal/async-process.js';

const TMUX_SESSION_PREFIX = 'elevenex-uterm';

interface UserPtySession {
  pty: pty.IPty;
  terminalId: number;
  tmuxSessionName: string;
  pid: number;
  useTmux: boolean;
}

interface TmuxResizeState {
  desired: {
    tmuxSessionName: string;
    cols: number;
    rows: number;
  };
  running: boolean;
}

@Injectable()
export class UserPtyManager implements OnModuleDestroy, OnApplicationShutdown {
  private processes = new Map<number, UserPtySession>();
  private readonly spawnInFlight = new Map<number, Promise<pty.IPty | null>>();
  private readonly cancelledSpawns = new Set<number>();
  private readonly tmuxResizeState = new Map<number, TmuxResizeState>();
  private pendingKills = new Set<number>();
  private readonly logger = new Logger('UserPtyManager');
  private tmuxBin: string;
  private scrollBindingsConfigured = false;
  private scrollBindingsConfigurePromise: Promise<void> | null = null;

  constructor(
    @Inject(forwardRef(() => UserTerminalGateway))
    private readonly gateway: UserTerminalGateway,
  ) {
    this.tmuxBin = this.resolveTmuxPath();
  }

  private resolveTmuxPath(): string {
    return findBinary('tmux') ?? '';
  }

  private isTmuxAvailable(): boolean {
    if (this.tmuxBin === '') {
      this.tmuxBin = this.resolveTmuxPath();
    }
    return this.tmuxBin !== '';
  }

  private async configureScrollBindings(): Promise<void> {
    if (this.scrollBindingsConfigured) return;
    if (this.scrollBindingsConfigurePromise) {
      return this.scrollBindingsConfigurePromise;
    }
    const tmpFile = path.join(
      os.tmpdir(),
      `elevenex-tmux-scroll-uterm-${process.pid}.conf`,
    );
    this.scrollBindingsConfigurePromise = (async () => {
      try {
        await fs.writeFile(tmpFile, generateTmuxScrollConfig());
        await execFileQuiet(this.tmuxBin, ['source-file', tmpFile]);
        await fs.unlink(tmpFile).catch(() => undefined);
        this.scrollBindingsConfigured = true;
      } catch {
        await fs.unlink(tmpFile).catch(() => undefined);
        // Ignore
      } finally {
        this.scrollBindingsConfigurePromise = null;
      }
    })();
    return this.scrollBindingsConfigurePromise;
  }

  private getTmuxSessionName(terminalId: number): string {
    return `${TMUX_SESSION_PREFIX}-${terminalId}`;
  }

  async spawn(
    terminalId: number,
    worktreePath: string,
    shell: string,
  ): Promise<pty.IPty | null> {
    const inFlight = this.spawnInFlight.get(terminalId);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.spawnInternal(terminalId, worktreePath, shell).finally(
      () => {
        if (this.spawnInFlight.get(terminalId) === promise) {
          this.spawnInFlight.delete(terminalId);
        }
      },
    );
    this.spawnInFlight.set(terminalId, promise);
    return promise;
  }

  private async spawnInternal(
    terminalId: number,
    worktreePath: string,
    shell: string,
  ): Promise<pty.IPty | null> {
    // Kill existing PTY attachment if any
    if (this.processes.has(terminalId)) {
      this.killProcess(terminalId);
    }

    const env: NodeJS.ProcessEnv = {
      ...(await buildAugmentedEnvAsync(process.env, worktreePath)),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };
    if (this.cancelledSpawns.has(terminalId)) {
      this.cancelledSpawns.delete(terminalId);
      return null;
    }

    if (this.processes.has(terminalId)) {
      this.killProcess(terminalId);
    }

    const tmuxSessionName = this.getTmuxSessionName(terminalId);

    if (this.isTmuxAvailable()) {
      const tmuxSession = await this.spawnWithTmux(
        terminalId,
        worktreePath,
        shell,
        env,
        tmuxSessionName,
      );
      if (this.cancelledSpawns.has(terminalId)) {
        this.cancelledSpawns.delete(terminalId);
        if (
          tmuxSession &&
          this.processes.get(terminalId)?.pty === tmuxSession
        ) {
          this.killProcess(terminalId);
        }
        return null;
      }
      if (tmuxSession) {
        return tmuxSession;
      }

      this.logger.warn(
        `Falling back to direct PTY for terminal ${terminalId} after tmux startup failed`,
      );
    }

    // Fallback: direct PTY spawn (no persistence)
    return this.spawnDirect(
      terminalId,
      worktreePath,
      shell,
      env,
      tmuxSessionName,
    );
  }

  private async spawnWithTmux(
    terminalId: number,
    worktreePath: string,
    shell: string,
    env: NodeJS.ProcessEnv,
    tmuxSessionName: string,
  ): Promise<pty.IPty | null> {
    try {
      if (!(await this.tmuxSessionExists(tmuxSessionName))) {
        this.logger.log(
          `Creating tmux session ${tmuxSessionName} in ${worktreePath}`,
        );
        await execFileQuiet(
          this.tmuxBin,
          [
            'new-session',
            '-d',
            '-s',
            tmuxSessionName,
            '-c',
            worktreePath,
            '-x',
            '80',
            '-y',
            '24',
            shell,
          ],
          {
            env: { ...env, TERM: 'xterm-256color' },
          },
        );

        // Enable mouse mode so tmux handles scrollback via copy-mode
        await this.configureTmuxSession(tmuxSessionName, env, true);
      } else {
        this.logger.log(
          `Reattaching to existing tmux session ${tmuxSessionName}`,
        );
        // Enable mouse mode so tmux handles scrollback via copy-mode
        try {
          await this.configureTmuxSession(tmuxSessionName, env, false);
        } catch {
          // Ignore
        }
      }

      await this.configureScrollBindings();
      return this.attachTmuxSession(terminalId, env, tmuxSessionName);
    } catch (error) {
      this.logger.error(
        `Failed to create/attach tmux session ${tmuxSessionName}: ${error}`,
      );
      return null;
    }
  }

  private attachTmuxSession(
    terminalId: number,
    env: NodeJS.ProcessEnv,
    tmuxSessionName: string,
  ): pty.IPty {
    const ptyProcess = pty.spawn(
      this.tmuxBin,
      ['attach', '-t', tmuxSessionName],
      {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: env.PWD || process.cwd(),
        env: {
          ...env,
          TERM: 'xterm-256color',
        },
      },
    );

    const pid = ptyProcess.pid;

    this.processes.set(terminalId, {
      pty: ptyProcess,
      terminalId,
      tmuxSessionName,
      pid,
      useTmux: true,
    });

    ptyProcess.onData((data) => {
      if (this.processes.get(terminalId)?.pty !== ptyProcess) {
        return;
      }
      this.gateway.sendToTerminal(terminalId, data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      this.logger.log(
        `tmux attach exited for terminal ${terminalId}: code=${exitCode}, signal=${signal}`,
      );
      if (this.processes.get(terminalId)?.pty !== ptyProcess) {
        return;
      }
      this.processes.delete(terminalId);
      // No auto-restart for user terminals
    });

    return ptyProcess;
  }

  private spawnDirect(
    terminalId: number,
    worktreePath: string,
    shell: string,
    env: NodeJS.ProcessEnv,
    tmuxSessionName: string,
  ): pty.IPty {
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: worktreePath,
      env,
    });

    const pid = ptyProcess.pid;

    this.processes.set(terminalId, {
      pty: ptyProcess,
      terminalId,
      tmuxSessionName,
      pid,
      useTmux: false,
    });

    ptyProcess.onData((data) => {
      if (this.processes.get(terminalId)?.pty !== ptyProcess) {
        return;
      }
      this.gateway.sendToTerminal(terminalId, data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      this.logger.log(
        `PTY exited for terminal ${terminalId}: code=${exitCode}, signal=${signal}`,
      );
      if (this.processes.get(terminalId)?.pty !== ptyProcess) {
        return;
      }
      this.processes.delete(terminalId);
    });

    return ptyProcess;
  }

  write(terminalId: number, data: string): void {
    const session = this.processes.get(terminalId);
    if (!session) return;
    session.pty.write(data);
  }

  resize(terminalId: number, cols: number, rows: number): void {
    const session = this.processes.get(terminalId);
    if (!session) return;
    if (cols < 2 || rows < 1) return;

    session.pty.resize(cols, rows);

    if (session.useTmux) {
      this.queueTmuxResize(
        terminalId,
        session.tmuxSessionName,
        cols,
        rows,
      );
    }
  }

  /** Kill PTY attachment only — tmux session survives for later reattach */
  kill(terminalId: number): boolean {
    const hadInFlightSpawn = this.spawnInFlight.has(terminalId);
    if (hadInFlightSpawn) {
      this.cancelledSpawns.add(terminalId);
    }
    return this.killProcess(terminalId) || hadInFlightSpawn;
  }

  private killProcess(terminalId: number): boolean {
    const session = this.processes.get(terminalId);

    if (session) {
      this.pendingKills.add(terminalId);
      try {
        session.pty.kill();

        setTimeout(() => {
          const current = this.processes.get(terminalId);
          if (current?.pty === session.pty && session.pid) {
            try {
              process.kill(session.pid, 'SIGKILL');
            } catch {
              // Already dead
            }
          }
        }, 5000);

        if (this.processes.get(terminalId)?.pty === session.pty) {
          this.processes.delete(terminalId);
        }
        return true;
      } catch (error) {
        this.logger.error(
          `Failed to kill PTY for terminal ${terminalId}: ${error}`,
        );
        if (this.processes.get(terminalId)?.pty === session.pty) {
          this.processes.delete(terminalId);
        }
        return false;
      }
    }
    return false;
  }

  /** Kill both PTY and tmux session — used when deleting a terminal */
  async destroy(terminalId: number): Promise<boolean> {
    this.kill(terminalId);
    this.tmuxResizeState.delete(terminalId);

    if (this.isTmuxAvailable()) {
      const tmuxSessionName = this.getTmuxSessionName(terminalId);
      try {
        await execFileQuiet(this.tmuxBin, [
          'kill-session',
          '-t',
          tmuxSessionName,
        ]);
      } catch {
        // Session may not exist
      }
    }
    return true;
  }

  isAlive(terminalId: number): boolean {
    return this.processes.has(terminalId);
  }

  async tmuxSessionExists(tmuxSessionName: string): Promise<boolean> {
    if (!this.isTmuxAvailable()) return false;
    try {
      await execFileQuiet(this.tmuxBin, ['has-session', '-t', tmuxSessionName]);
      return true;
    } catch {
      return false;
    }
  }

  hasTmuxSessionForTerminal(terminalId: number): Promise<boolean> {
    return this.tmuxSessionExists(this.getTmuxSessionName(terminalId));
  }

  onModuleDestroy(): void {
    this.killAll();
  }

  onApplicationShutdown(signal?: string): void {
    this.logger.log(`Shutting down UserPtyManager (${signal})...`);
    this.killAll();
  }

  private killAll(): void {
    this.logger.log(
      `Killing ${this.processes.size} user terminal PTY processes...`,
    );
    for (const [terminalId] of this.processes) {
      this.kill(terminalId);
    }
  }

  private async configureTmuxSession(
    tmuxSessionName: string,
    env: NodeJS.ProcessEnv,
    includeHistoryLimit: boolean,
  ): Promise<void> {
    await execFileQuiet(
      this.tmuxBin,
      ['set-window-option', '-t', tmuxSessionName, 'alternate-screen', 'on'],
      { env },
    );
    await execFileQuiet(
      this.tmuxBin,
      ['set-option', '-t', tmuxSessionName, 'mouse', 'on'],
      {
        env,
      },
    );
    if (includeHistoryLimit) {
      await execFileQuiet(
        this.tmuxBin,
        ['set-option', '-t', tmuxSessionName, 'history-limit', '50000'],
        { env },
      );
    }
    await execFileQuiet(
      this.tmuxBin,
      ['set-option', '-t', tmuxSessionName, 'status', 'off'],
      {
        env,
      },
    );
    await this.setTmuxWindowSizeModeLatest(tmuxSessionName);
  }

  private async resizeTmuxWindow(
    tmuxSessionName: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    await this.setTmuxWindowSizeModeLatest(tmuxSessionName);
    await execFileQuiet(this.tmuxBin, [
      'set-option',
      '-t',
      tmuxSessionName,
      'default-size',
      `${cols}x${rows}`,
    ]);
  }

  private async setTmuxWindowSizeModeLatest(
    tmuxSessionName: string,
  ): Promise<void> {
    try {
      await execFileQuiet(this.tmuxBin, [
        'set-option',
        '-t',
        tmuxSessionName,
        'window-size',
        'latest',
      ]);
    } catch {
      // Older tmux versions or dead sessions may reject this; pty.resize still
      // carries the live client size.
    }
  }

  private queueTmuxResize(
    terminalId: number,
    tmuxSessionName: string,
    cols: number,
    rows: number,
  ): void {
    const existing = this.tmuxResizeState.get(terminalId);
    const state =
      existing ??
      ({
        desired: { tmuxSessionName, cols, rows },
        running: false,
      } satisfies TmuxResizeState);

    state.desired = { tmuxSessionName, cols, rows };
    this.tmuxResizeState.set(terminalId, state);

    if (state.running) {
      return;
    }

    state.running = true;
    void this.flushQueuedTmuxResize(terminalId, state);
  }

  private async flushQueuedTmuxResize(
    terminalId: number,
    state: TmuxResizeState,
  ): Promise<void> {
    try {
      while (this.tmuxResizeState.get(terminalId) === state) {
        const { tmuxSessionName, cols, rows } = state.desired;

        try {
          await this.resizeTmuxWindow(tmuxSessionName, cols, rows);
        } catch {
          // Ignore resize errors.
        }

        const desired = state.desired;
        if (
          desired.tmuxSessionName === tmuxSessionName &&
          desired.cols === cols &&
          desired.rows === rows
        ) {
          break;
        }
      }
    } finally {
      if (this.tmuxResizeState.get(terminalId) === state) {
        this.tmuxResizeState.delete(terminalId);
      }
    }
  }
}
