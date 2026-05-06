import {
  Injectable,
  OnModuleDestroy,
  OnApplicationShutdown,
  Inject,
  forwardRef,
  Logger,
} from '@nestjs/common';
import * as pty from 'node-pty';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { UserTerminalGateway } from './user-terminal.gateway.js';
import { generateTmuxScrollConfig } from '../terminal/tmux-scroll-config.js';
import { buildAugmentedEnv, findBinary } from '../config/system-paths.js';

const TMUX_SESSION_PREFIX = 'elevenex-uterm';

interface UserPtySession {
  pty: pty.IPty;
  terminalId: number;
  tmuxSessionName: string;
  pid: number;
}

@Injectable()
export class UserPtyManager implements OnModuleDestroy, OnApplicationShutdown {
  private processes = new Map<number, UserPtySession>();
  private pendingKills = new Set<number>();
  private readonly logger = new Logger('UserPtyManager');
  private tmuxBin: string;
  private scrollBindingsConfigured = false;

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
    return this.tmuxBin !== '';
  }

  private configureScrollBindings(): void {
    if (this.scrollBindingsConfigured) return;
    try {
      const tmpFile = path.join(os.tmpdir(), `elevenex-tmux-scroll-uterm-${process.pid}.conf`);
      fs.writeFileSync(tmpFile, generateTmuxScrollConfig());
      execSync(`${this.tmuxBin} source-file ${tmpFile}`, { stdio: 'ignore' });
      fs.unlinkSync(tmpFile);
      this.scrollBindingsConfigured = true;
    } catch {
      // Ignore
    }
  }

  private getTmuxSessionName(terminalId: number): string {
    return `${TMUX_SESSION_PREFIX}-${terminalId}`;
  }

  spawn(terminalId: number, worktreePath: string, shell: string): pty.IPty | null {
    // Kill existing PTY attachment if any
    if (this.processes.has(terminalId)) {
      this.kill(terminalId);
    }

    const env: NodeJS.ProcessEnv = {
      ...buildAugmentedEnv(process.env, worktreePath),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };

    const tmuxSessionName = this.getTmuxSessionName(terminalId);

    if (this.isTmuxAvailable()) {
      return this.spawnWithTmux(terminalId, worktreePath, shell, env, tmuxSessionName);
    }

    // Fallback: direct PTY spawn (no persistence)
    return this.spawnDirect(terminalId, worktreePath, shell, env, tmuxSessionName);
  }

  private spawnWithTmux(
    terminalId: number,
    worktreePath: string,
    shell: string,
    env: NodeJS.ProcessEnv,
    tmuxSessionName: string,
  ): pty.IPty | null {
    try {
      if (!this.tmuxSessionExists(tmuxSessionName)) {
        this.logger.log(`Creating tmux session ${tmuxSessionName} in ${worktreePath}`);
        execSync(
          `${this.tmuxBin} new-session -d -s ${tmuxSessionName} -c "${worktreePath}" -x 80 -y 24 "${shell}"`,
          {
            stdio: 'pipe',
            env: { ...env, TERM: 'xterm-256color' },
          },
        );

        // Enable mouse mode so tmux handles scrollback via copy-mode
        execSync(`${this.tmuxBin} set-window-option -t ${tmuxSessionName} alternate-screen on`, { stdio: 'ignore', env });
        execSync(`${this.tmuxBin} set-option -t ${tmuxSessionName} mouse on`, { stdio: 'ignore', env });
        execSync(`${this.tmuxBin} set-option -t ${tmuxSessionName} history-limit 50000`, { stdio: 'ignore', env });
        execSync(`${this.tmuxBin} set-option -t ${tmuxSessionName} status off`, { stdio: 'ignore', env });
      } else {
        this.logger.log(`Reattaching to existing tmux session ${tmuxSessionName}`);
        // Enable mouse mode so tmux handles scrollback via copy-mode
        try {
          execSync(`${this.tmuxBin} set-window-option -t ${tmuxSessionName} alternate-screen on`, { stdio: 'ignore', env });
          execSync(`${this.tmuxBin} set-option -t ${tmuxSessionName} mouse on`, { stdio: 'ignore', env });
          execSync(`${this.tmuxBin} set-option -t ${tmuxSessionName} status off`, { stdio: 'ignore', env });
        } catch {
          // Ignore
        }
      }

      this.configureScrollBindings();
      return this.attachTmuxSession(terminalId, env, tmuxSessionName);
    } catch (error) {
      this.logger.error(`Failed to create/attach tmux session ${tmuxSessionName}: ${error}`);
      return null;
    }
  }

  private attachTmuxSession(
    terminalId: number,
    env: NodeJS.ProcessEnv,
    tmuxSessionName: string,
  ): pty.IPty {
    const ptyProcess = pty.spawn(this.tmuxBin, ['attach', '-t', tmuxSessionName], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: env.PWD || process.cwd(),
      env: {
        ...env,
        TERM: 'xterm-256color',
      },
    });

    const pid = ptyProcess.pid;

    this.processes.set(terminalId, {
      pty: ptyProcess,
      terminalId,
      tmuxSessionName,
      pid,
    });

    ptyProcess.onData((data) => {
      this.gateway.sendToTerminal(terminalId, data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      this.logger.log(`tmux attach exited for terminal ${terminalId}: code=${exitCode}, signal=${signal}`);
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
    });

    ptyProcess.onData((data) => {
      this.gateway.sendToTerminal(terminalId, data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      this.logger.log(`PTY exited for terminal ${terminalId}: code=${exitCode}, signal=${signal}`);
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

    // Also resize tmux window
    if (this.isTmuxAvailable()) {
      try {
        execSync(`${this.tmuxBin} set-option -t ${session.tmuxSessionName} default-size ${cols}x${rows}`, { stdio: 'ignore' });
        execSync(`${this.tmuxBin} resize-window -t ${session.tmuxSessionName} ${cols} ${rows}`, { stdio: 'ignore' });
      } catch {
        // Ignore resize errors
      }
    }
  }

  /** Kill PTY attachment only — tmux session survives for later reattach */
  kill(terminalId: number): boolean {
    this.pendingKills.add(terminalId);
    const session = this.processes.get(terminalId);

    if (session) {
      try {
        session.pty.kill();

        setTimeout(() => {
          if (this.processes.has(terminalId) && session.pid) {
            try {
              process.kill(session.pid, 'SIGKILL');
            } catch {
              // Already dead
            }
          }
        }, 5000);

        this.processes.delete(terminalId);
        return true;
      } catch (error) {
        this.logger.error(`Failed to kill PTY for terminal ${terminalId}: ${error}`);
        this.processes.delete(terminalId);
        return false;
      }
    }
    return false;
  }

  /** Kill both PTY and tmux session — used when deleting a terminal */
  destroy(terminalId: number): boolean {
    this.kill(terminalId);

    if (this.isTmuxAvailable()) {
      const tmuxSessionName = this.getTmuxSessionName(terminalId);
      try {
        execSync(`${this.tmuxBin} kill-session -t ${tmuxSessionName} 2>/dev/null`, { stdio: 'ignore' });
      } catch {
        // Session may not exist
      }
    }
    return true;
  }

  isAlive(terminalId: number): boolean {
    return this.processes.has(terminalId);
  }

  tmuxSessionExists(tmuxSessionName: string): boolean {
    if (!this.isTmuxAvailable()) return false;
    try {
      execSync(`${this.tmuxBin} has-session -t ${tmuxSessionName} 2>/dev/null`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  hasTmuxSessionForTerminal(terminalId: number): boolean {
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
    this.logger.log(`Killing ${this.processes.size} user terminal PTY processes...`);
    for (const [terminalId] of this.processes) {
      this.kill(terminalId);
    }
  }
}
