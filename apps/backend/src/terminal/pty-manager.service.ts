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
import { TerminalGateway } from './terminal.gateway.js';
import { TmuxManager } from './tmux-manager.service.js';
import { PlannotatorRegistryService } from '../plannotator/plannotator-registry.service.js';
import { getBackendHelperPath } from '../config/runtime-paths.js';
import {
  buildAugmentedEnvAsync,
  buildTmuxInlineEnvPrefix,
  findBinary,
} from '../config/system-paths.js';
import { buildManagedPlannotatorEnv } from '../plannotator/plannotator-env.js';
import { execFileQuiet } from './async-process.js';

interface PtySession {
  pty: pty.IPty;
  sessionId: number;
  worktreePath: string;
  pid: number;
  useTmux: boolean;
}

const CLAUDE_BIN = findBinary('claude') ?? 'claude';
const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
] as const;
const logger = new Logger('PtyManager');
logger.log(`Using claude binary: ${CLAUDE_BIN}`);

@Injectable()
export class PtyManager implements OnModuleDestroy, OnApplicationShutdown {
  private processes = new Map<number, PtySession>();
  private pendingKills = new Set<number>();
  private readonly logger = new Logger('PtyManager');

  private wrapperScriptPath: string;

  constructor(
    @Inject(forwardRef(() => TerminalGateway))
    private readonly gateway: TerminalGateway,
    private readonly tmuxManager: TmuxManager,
    private readonly plannotatorRegistry: PlannotatorRegistryService,
  ) {
    this.wrapperScriptPath = getBackendHelperPath(
      'bin',
      'plannotator-wrapper.sh',
    );
  }

  async spawn(
    sessionId: number,
    worktreePath: string,
    resumeSessionId?: string,
  ): Promise<pty.IPty | null> {
    const reusingTmuxSession =
      this.tmuxManager.isTmuxAvailable() &&
      (await this.tmuxManager.sessionExists(sessionId));

    // Kill existing process if any
    this.kill(sessionId);

    const hooksArgs = await this.buildHooksSettingsArgs();
    const args = [
      '--enable-auto-mode',
      ...hooksArgs,
      ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
    ];

    this.plannotatorRegistry.registerLaunch(sessionId, worktreePath, {
      reuseExisting: reusingTmuxSession,
    });

    const env = buildManagedPlannotatorEnv(sessionId, this.wrapperScriptPath, {
      ...(await buildAugmentedEnvAsync(process.env, worktreePath)),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    });

    if (this.processes.has(sessionId)) {
      this.kill(sessionId);
    }

    this.logger.log(`Spawning PTY for session ${sessionId} in ${worktreePath}`);

    // Try tmux first if available
    if (this.tmuxManager.isTmuxAvailable()) {
      const tmuxSession = await this.spawnWithTmux(
        sessionId,
        worktreePath,
        args,
        env,
      );
      if (tmuxSession) {
        return tmuxSession;
      }
    }

    // Fall back to direct PTY spawn
    return this.spawnDirect(sessionId, worktreePath, args, env);
  }

  private async spawnWithTmux(
    sessionId: number,
    worktreePath: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<pty.IPty | null> {
    const sessionName = `elevenex-${sessionId}`;
    const tmuxBin = this.tmuxManager.getTmuxBin();

    try {
      // Check if tmux session already exists
      if (await this.tmuxManager.sessionExists(sessionId)) {
        this.logger.log(`Attaching to existing tmux session ${sessionName}`);
        // Update tmux session environment so new processes inherit plannotator vars
        const plannotatorEnvVars = [
          'PLANNOTATOR_BROWSER',
          'PLANNOTATOR_REMOTE',
          'ELEVENEX_SESSION_ID',
          'ELEVENEX_PORT',
        ];
        for (const key of plannotatorEnvVars) {
          if (env[key]) {
            try {
              await execFileQuiet(
                tmuxBin,
                ['set-environment', '-t', sessionName, key, env[key]],
                {
                  env,
                },
              );
            } catch {
              // Ignore - tmux may not support set-environment in all cases
            }
          }
        }
        try {
          await execFileQuiet(
            tmuxBin,
            ['set-environment', '-u', '-t', sessionName, 'PLANNOTATOR_PORT'],
            { env },
          );
        } catch {
          // Ignore - tmux may not support unset in all cases
        }
        // Enable mouse mode so tmux handles scrollback via copy-mode
        try {
          await this.configureTmuxSession(tmuxBin, sessionName, env, false);
        } catch {
          // Ignore
        }
        await this.tmuxManager.configureScrollBindings();
        return this.attachTmuxSession(sessionId, env);
      }

      // Create new tmux session
      this.logger.log(
        `Creating new tmux session ${sessionName} in ${worktreePath}`,
      );

      // Inline critical env vars in the shell command inside tmux.
      // The env passed to the tmux client does not affect the tmux server
      // the server which spawns the actual process — so PATH and
      // version-manager hints must be inlined to reach claude.
      const envPrefix = buildTmuxInlineEnvPrefix(env, [
        'ELEVENEX_SESSION_ID',
        'ELEVENEX_PORT',
        'PLANNOTATOR_REMOTE',
        'PLANNOTATOR_BROWSER',
      ]);

      const claudeArgv = [CLAUDE_BIN, ...args]
        .map((arg) => this.shellEscape(arg))
        .join(' ');
      const claudeCmd = `unset SSH_TTY SSH_CONNECTION PLANNOTATOR_PORT && ${envPrefix} ${claudeArgv}`;

      await execFileQuiet(
        tmuxBin,
        [
          'new-session',
          '-d',
          '-s',
          sessionName,
          '-c',
          worktreePath,
          '-x',
          '80',
          '-y',
          '24',
          claudeCmd,
        ],
        {
          env: { ...env, TERM: 'xterm-256color' },
        },
      );

      // Enable mouse mode so tmux handles scrollback via copy-mode
      await this.configureTmuxSession(tmuxBin, sessionName, env, true);
      await this.tmuxManager.configureScrollBindings();

      // Attach to the tmux session via PTY
      return this.attachTmuxSession(sessionId, env);
    } catch (error) {
      this.logger.error(
        `Failed to create tmux session ${sessionName}: ${error}`,
      );
      return null;
    }
  }

  private attachTmuxSession(
    sessionId: number,
    env: NodeJS.ProcessEnv,
  ): pty.IPty {
    const sessionName = `elevenex-${sessionId}`;
    const tmuxBin = this.tmuxManager.getTmuxBin();

    // Spawn tmux attach inside a PTY - this handles terminal emulation correctly
    const ptyProcess = pty.spawn(tmuxBin, ['attach', '-t', sessionName], {
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

    this.processes.set(sessionId, {
      pty: ptyProcess,
      sessionId,
      worktreePath: '',
      pid,
      useTmux: true,
    });

    // Pipe PTY output to WebSocket
    ptyProcess.onData((data) => {
      this.gateway.sendToSession(sessionId, data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      this.logger.log(
        `tmux attach exited for session ${sessionId}: code=${exitCode}, signal=${signal}`,
      );
      this.processes.delete(sessionId);
      this.handleProcessExit(sessionId, exitCode, signal, true);
    });

    return ptyProcess;
  }

  private spawnDirect(
    sessionId: number,
    worktreePath: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): pty.IPty {
    const ptyProcess = pty.spawn(CLAUDE_BIN, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: worktreePath,
      env,
    });

    const pid = ptyProcess.pid;

    this.processes.set(sessionId, {
      pty: ptyProcess,
      sessionId,
      worktreePath,
      pid,
      useTmux: false,
    });

    // Pipe PTY output to WebSocket
    ptyProcess.onData((data) => {
      this.gateway.sendToSession(sessionId, data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      this.logger.log(
        `PTY exited for session ${sessionId}: code=${exitCode}, signal=${signal}`,
      );
      this.processes.delete(sessionId);
      this.handleProcessExit(sessionId, exitCode, signal, false);
    });

    return ptyProcess;
  }

  write(sessionId: number, data: string): void {
    const session = this.processes.get(sessionId);
    if (!session) return;

    // Write to the PTY (which is either attached to tmux or running claude directly)
    session.pty.write(data);
  }

  resize(sessionId: number, cols: number, rows: number): void {
    const session = this.processes.get(sessionId);
    if (!session) return;
    if (cols < 2 || rows < 1) return;

    // Resize the PTY
    session.pty.resize(cols, rows);

    // If using tmux, also resize the tmux window
    if (session.useTmux) {
      const sessionName = `elevenex-${sessionId}`;
      const tmuxBin = this.tmuxManager.getTmuxBin();
      void this.resizeTmuxWindow(tmuxBin, sessionName, cols, rows).catch(() => {
        // Ignore resize errors
      });
    }
  }

  private handleProcessExit(
    sessionId: number,
    exitCode: number,
    signal: number | undefined,
    useTmux: boolean,
  ): void {
    if (!useTmux) {
      this.plannotatorRegistry.markLaunchInactive(sessionId);
    }

    if (this.pendingKills.has(sessionId)) {
      this.pendingKills.delete(sessionId);
      return; // Intentional kill, don't restart
    }
    this.gateway.onUnexpectedExit(sessionId, exitCode, signal);
  }

  kill(sessionId: number): boolean {
    this.pendingKills.add(sessionId);
    const session = this.processes.get(sessionId);

    if (session) {
      if (!session.useTmux) {
        this.plannotatorRegistry.markLaunchInactive(sessionId);
      }

      try {
        session.pty.kill();

        // Force kill after timeout
        setTimeout(() => {
          if (this.processes.has(sessionId) && session.pid) {
            try {
              process.kill(session.pid, 'SIGKILL');
            } catch {
              // Process already dead
            }
          }
        }, 5000);

        this.processes.delete(sessionId);
        return true;
      } catch (error) {
        this.logger.error(
          `Failed to kill PTY for session ${sessionId}: ${error}`,
        );
        this.processes.delete(sessionId);
        return false;
      }
    }
    return false;
  }

  async killTmuxSession(sessionId: number): Promise<void> {
    this.plannotatorRegistry.markLaunchInactive(sessionId);
    if (this.tmuxManager.isTmuxAvailable()) {
      await this.tmuxManager.killSession(sessionId);
    }
  }

  isAlive(sessionId: number): boolean {
    // Only check if PTY process is running
    // tmux session existing doesn't count - we need to reattach via new PTY
    return this.processes.has(sessionId);
  }

  async hasTmuxSession(sessionId: number): Promise<boolean> {
    return (
      this.tmuxManager.isTmuxAvailable() &&
      (await this.tmuxManager.sessionExists(sessionId))
    );
  }

  getPid(sessionId: number): number | undefined {
    return this.processes.get(sessionId)?.pid;
  }

  onModuleDestroy(): void {
    this.killAll();
  }

  onApplicationShutdown(signal?: string): void {
    this.logger.log(`Shutting down PTY manager (${signal})...`);
    this.killAll();
  }

  private killAll(): void {
    this.logger.log(`Killing ${this.processes.size} Claude PTY processes...`);
    for (const [sessionId] of this.processes) {
      this.kill(sessionId);
    }
  }

  /**
   * Build --settings CLI args for Claude Code hooks.
   * Writes the settings JSON to a temp file to avoid shell quoting issues
   * (especially inside tmux commands). The temp file persists for the session lifetime.
   */
  private async buildHooksSettingsArgs(): Promise<string[]> {
    const curlCmd = () =>
      `body=$(cat); curl -s -X POST -H 'Content-Type: application/json' -H "X-Elevenex-Session-Id: $ELEVENEX_SESSION_ID" --data-binary "$body" http://localhost:$ELEVENEX_PORT/api/claude-hooks/event > /dev/null 2>&1 || true`;

    const hooksConfig = {
      hooks: Object.fromEntries(
        HOOK_EVENTS.map((eventName) => [
          eventName,
          [
            {
              matcher: '',
              hooks: [{ type: 'command', command: curlCmd(), timeout: 3 }],
            },
          ],
        ]),
      ),
    };

    // Write to a temp file to avoid shell quoting issues in tmux
    const tmpFile = path.join(
      os.tmpdir(),
      `elevenex-hooks-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    await fs.writeFile(tmpFile, JSON.stringify(hooksConfig));

    return ['--settings', tmpFile];
  }

  private shellEscape(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  private async configureTmuxSession(
    tmuxBin: string,
    sessionName: string,
    env: NodeJS.ProcessEnv,
    includeHistoryLimit: boolean,
  ): Promise<void> {
    await execFileQuiet(
      tmuxBin,
      ['set-window-option', '-t', sessionName, 'alternate-screen', 'on'],
      { env },
    );
    await execFileQuiet(
      tmuxBin,
      ['set-option', '-t', sessionName, 'mouse', 'on'],
      {
        env,
      },
    );
    if (includeHistoryLimit) {
      await execFileQuiet(
        tmuxBin,
        ['set-option', '-t', sessionName, 'history-limit', '50000'],
        { env },
      );
    }
    await execFileQuiet(
      tmuxBin,
      ['set-option', '-t', sessionName, 'status', 'off'],
      {
        env,
      },
    );
  }

  private async resizeTmuxWindow(
    tmuxBin: string,
    sessionName: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    await execFileQuiet(tmuxBin, [
      'set-option',
      '-t',
      sessionName,
      'default-size',
      `${cols}x${rows}`,
    ]);
    await execFileQuiet(tmuxBin, [
      'resize-window',
      '-t',
      sessionName,
      String(cols),
      String(rows),
    ]);
  }
}
