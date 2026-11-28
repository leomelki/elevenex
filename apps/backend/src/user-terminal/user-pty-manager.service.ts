import {
  DesktopTerminalStream,
  DESKTOP_TERMINAL_INITIAL_SIZE,
} from './desktop-terminal-stream.js';
import { randomUUID } from 'node:crypto';
import { desktopShellIntegration } from './desktop-shell-integration.js';
import {
  Injectable,
  OnModuleDestroy,
  OnApplicationShutdown,
  Inject,
  forwardRef,
  Logger,
} from '@nestjs/common';
import * as pty from 'node-pty';
import { TerminalOutputBuffer } from '../terminal/terminal-output-buffer.js';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UserTerminalGateway } from './user-terminal.gateway.js';
import { generateTmuxScrollConfig } from '../terminal/tmux-scroll-config.js';
import {
  buildAugmentedEnv,
  buildAugmentedEnvAsync,
  findBinary,
  normalizeShellForPlatform,
  stripInheritedTmuxEnv,
} from '../config/system-paths.js';
import { execFileQuiet } from '../terminal/async-process.js';
import { shouldUseTmux } from '../config/backend-runtime-mode.js';
import { terminatePtyAndWait } from '../terminal/pty-termination.js';
import { TerminalPortDiscovery } from './ports/terminal-port-discovery.js';
import { TerminalScreenHost } from './screen/terminal-screen-host.js';
import type { TerminalLaunchOptions } from './terminal-launch.js';

const TMUX_SESSION_PREFIX = 'elevenex-uterm';

interface UserPtySession {
  pty: pty.IPty;
  terminalId: number;
  tmuxSessionName: string;
  pid: number;
  useTmux: boolean;
  output?: TerminalOutputBuffer;
  stopPortDiscovery?: () => void;
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
  readonly screens = new TerminalScreenHost(undefined, () => { for (const stream of this.desktopStreams.values()) stream.changed(); });
  private shuttingDown = false;
  // Metadata remains until explicit close. No attachment can create/restart a desktop shell.
  private readonly desktopStreams = new Map<number, DesktopTerminalStream>();
  private readonly desktopCleanup = new Map<number, () => Promise<void>>();
  private readonly portDiscovery = new TerminalPortDiscovery(
    undefined,
    (error) =>
      this.logger.warn(
        `Terminal port discovery unavailable: ${error instanceof Error ? error.message.slice(0, 240) : 'unknown collector error'}`,
      ),
  );
  refreshDesktopPorts(fresh = false): Promise<void> {
    return this.portDiscovery.refresh(fresh);
  }
  desktopStream(id: number): DesktopTerminalStream | undefined {
    return this.desktopStreams.get(id);
  }

  async spawnDesktop(
    id: number,
    cwd: string,
    shell: string,
    script: DesktopTerminalStream['script'] = null,
    generation = this.getGeneration(id),
    shellIntegration = true,
    launch: TerminalLaunchOptions = {},
  ): Promise<void> {
    if (
      this.shuttingDown ||
      this.strictStops.has(id) ||
      generation !== this.getGeneration(id)
    )
      throw new Error('Terminal startup was cancelled');
    if (
      this.desktopStreams.has(id) ||
      this.isAlive(id) ||
      this.spawnInFlight.has(id)
    )
      throw new Error('Terminal already started');
    if (this.desktopStreams.size >= 128) {
      const expired = [...this.desktopStreams.keys()].find(
        (key) => !this.isAlive(key) && !this.spawnInFlight.has(key),
      );
      if (expired !== undefined) this.forgetDesktop(expired);
      else throw new Error('User terminal process limit reached');
    }
    const promptToken = randomUUID();
    const stream = new DesktopTerminalStream(script, promptToken, launch);
    stream.protocolOwned = launch.protocol === 1;
    this.desktopStreams.set(id, stream);
    const promise = Promise.resolve()
      .then(async () => {
        const inherited = stripInheritedTmuxEnv(await buildAugmentedEnvAsync(process.env, cwd));
        // Desktop/backend capabilities must never become shell environment data.
        delete inherited.ELEVENEX_CODE_ACCESS; delete inherited.ELEVENEX_DESKTOP_SOCKET;
        for (const [key, value] of Object.entries(launch.profile?.env ?? {})) {
          if (value === null) delete inherited[key];
          else Object.defineProperty(inherited, key, { value, enumerable: true, configurable: true, writable: true });
        }
        const baseEnv = {
          ...inherited,
          ELEVENEX_USER_CWD: cwd,
          TERM_PROGRAM: 'elevenex',
        };
        const selectedShell = launch.profile?.executable ?? normalizeShellForPlatform(shell);
        const customArgs = launch.profile ? [...(launch.profile.login ? ['-l'] : []), ...launch.profile.args] : [];
        const integration = script
          ? { args: script.args, env: baseEnv, cleanup: async () => {} }
          : await desktopShellIntegration(
              selectedShell,
              baseEnv,
              promptToken,
              shellIntegration && customArgs.length === 0,
            );
        if ('integration' in integration)
          stream.configureIntegration(integration.integration);
        this.desktopCleanup.set(id, integration.cleanup);
        if (
          this.shuttingDown ||
          this.cancelledSpawns.has(id) ||
          this.getGeneration(id) !== generation
        ) {
          this.cancelledSpawns.delete(id);
          await integration.cleanup();
          this.desktopCleanup.delete(id);
          return null;
        }
        return this.spawnDirect(
          id,
          cwd,
          script?.file ?? selectedShell,
          {
            ...integration.env,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
          },
          this.getTmuxSessionName(id),
          customArgs.length && !script ? customArgs : integration.args,
          launch.size,
        );
      })
      .finally(() => {
        if (this.spawnInFlight.get(id) === promise)
          this.spawnInFlight.delete(id);
      });
    this.spawnInFlight.set(id, promise);
    try {
      if (!(await promise)) throw new Error('Terminal startup was cancelled');
    } catch (error) {
      stream.exited(1);
      throw error;
    }
  }
  private processes = new Map<number, UserPtySession>();
  private readonly spawnInFlight = new Map<number, Promise<pty.IPty | null>>();
  private readonly cancelledSpawns = new Set<number>();
  private readonly generations = new Map<number, number>();
  private readonly strictStops = new Set<number>();
  private readonly tmuxResizeState = new Map<number, TmuxResizeState>();
  private readonly pendingKills = new Map<number, Set<pty.IPty>>();
  private readonly logger = new Logger('UserPtyManager');
  private readonly tmuxEnabled: boolean;
  private tmuxBin: string;
  private scrollBindingsConfigured = false;
  private scrollBindingsConfigurePromise: Promise<void> | null = null;

  constructor(
    @Inject(forwardRef(() => UserTerminalGateway))
    private readonly gateway: UserTerminalGateway,
  ) {
    this.tmuxEnabled = shouldUseTmux();
    this.tmuxBin = this.tmuxEnabled ? this.resolveTmuxPath() : '';
  }

  private resolveTmuxPath(): string {
    return findBinary('tmux') ?? '';
  }

  private isTmuxAvailable(): boolean {
    if (!this.tmuxEnabled) return false;
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
    generation = this.getGeneration(terminalId),
  ): Promise<pty.IPty | null> {
    if (
      this.shuttingDown ||
      this.strictStops.has(terminalId) ||
      generation !== this.getGeneration(terminalId)
    )
      return null;

    const inFlight = this.spawnInFlight.get(terminalId);
    if (inFlight) {
      return inFlight;
    }

    // Register the in-flight operation before startup or cancellation can run.
    const promise = Promise.resolve()
      .then(() => this.spawnInternal(terminalId, worktreePath, shell))
      .finally(() => {
        if (this.spawnInFlight.get(terminalId) === promise) {
          this.spawnInFlight.delete(terminalId);
        }
      });
    this.spawnInFlight.set(terminalId, promise);
    return promise;
  }

  private async spawnInternal(
    terminalId: number,
    worktreePath: string,
    rawShell: string,
  ): Promise<pty.IPty | null> {
    // A legacy replacement keeps its original replay protocol. Old desktop
    // cursors/keystrokes must not silently attach to that new process.
    this.forgetDesktop(terminalId);
    // Persisted shells may be POSIX paths (e.g. /bin/zsh) that cannot launch on
    // Windows; fall back to the platform default so the terminal still opens.
    const shell = normalizeShellForPlatform(rawShell);

    // Kill existing PTY attachment if any
    if (this.processes.has(terminalId)) {
      this.killProcess(terminalId);
    }

    const tmuxSessionName = this.getTmuxSessionName(terminalId);
    const useTmux = this.isTmuxAvailable();
    const reusingTmuxSession =
      useTmux && (await this.tmuxSessionExists(tmuxSessionName));
    if (this.cancelledSpawns.has(terminalId) || this.shuttingDown) {
      this.cancelledSpawns.delete(terminalId);
      return null;
    }
    const env: NodeJS.ProcessEnv = {
      ...stripInheritedTmuxEnv(
        // A fresh shell needs the project environment, including login profiles
        // that an interactive non-login shell does not source. A running tmux
        // session already owns that environment and only needs a new client.
        reusingTmuxSession
          ? buildAugmentedEnv(process.env, worktreePath)
          : await buildAugmentedEnvAsync(process.env, worktreePath),
      ),
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

    if (useTmux) {
      const tmuxSession = await this.spawnWithTmux(
        terminalId,
        worktreePath,
        shell,
        env,
        tmuxSessionName,
        reusingTmuxSession,
      );
      if (this.cancelledSpawns.has(terminalId)) {
        this.cancelledSpawns.delete(terminalId);
        if (
          tmuxSession &&
          this.processes.get(terminalId)?.pty === tmuxSession &&
          !this.strictStops.has(terminalId)
        ) {
          this.killProcess(terminalId);
        }
        return null;
      }
      return tmuxSession;
    }

    // Direct PTYs live until explicitly closed or the backend shuts down.
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
    reusingTmuxSession: boolean,
  ): Promise<pty.IPty | null> {
    try {
      if (this.cancelledSpawns.has(terminalId) || this.shuttingDown)
        return null;
      if (!reusingTmuxSession) {
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
      if (this.cancelledSpawns.has(terminalId) || this.shuttingDown)
        return null;
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
      if (!this.pendingKills.get(terminalId)?.has(ptyProcess)) {
        this.gateway.onProcessExit(terminalId);
      }
    });

    return ptyProcess;
  }

  private spawnDirect(
    terminalId: number,
    worktreePath: string,
    shell: string,
    env: NodeJS.ProcessEnv,
    tmuxSessionName: string,
    args: string[] = [],
    size: { readonly cols: number; readonly rows: number } = DESKTOP_TERMINAL_INITIAL_SIZE,
  ): pty.IPty {
    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      ...size,
      cwd: worktreePath,
      env,
    });

    const pid = ptyProcess.pid;
    const output = this.desktopStreams.has(terminalId)
      ? undefined
      : new TerminalOutputBuffer();

    const stream = this.desktopStreams.get(terminalId);
    this.processes.set(terminalId, {
      pty: ptyProcess,
      terminalId,
      tmuxSessionName,
      pid,
      useTmux: false,
      output,
      ...(stream
        ? {
            stopPortDiscovery: this.portDiscovery.register(
              terminalId,
              pid,
              (listeners) => { stream.services.reconcile(listeners); stream.changed(); },
            ),
          }
        : {}),
    });

    if (stream) {
      stream.resize(size.cols, size.rows);
      this.screens.open(terminalId, size.cols, size.rows, {
        pause: () => { if (this.processes.get(terminalId)?.pty === ptyProcess) ptyProcess.pause(); },
        resume: () => { if (this.processes.get(terminalId)?.pty === ptyProcess) ptyProcess.resume(); },
        reply: data => {
          if (stream.protocolOwned && this.processes.get(terminalId)?.pty === ptyProcess) ptyProcess.write(data);
        },
      });
    }
    ptyProcess.onData((data) => {
      if (this.processes.get(terminalId)?.pty !== ptyProcess) {
        return;
      }
      output?.append(data);
      // Post to the model before notifying consumers. A checkpoint requested
      // by that notification must include the bytes which advanced its cursor.
      if (stream) this.screens.write(terminalId, data, stream.sequence + data.length);
      this.desktopStreams.get(terminalId)?.append(data);
      this.gateway.sendToTerminal(terminalId, data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      this.logger.log(
        `PTY exited for terminal ${terminalId}: code=${exitCode}, signal=${signal}`,
      );
      if (this.processes.get(terminalId)?.pty !== ptyProcess) {
        return;
      }
      this.processes.get(terminalId)?.stopPortDiscovery?.();
      this.desktopStreams.get(terminalId)?.exited(exitCode);
      const cleanup = this.desktopCleanup.get(terminalId);
      this.desktopCleanup.delete(terminalId);
      if (cleanup)
        void cleanup().catch(() =>
          this.logger.warn('Terminal integration cleanup failed'),
        );
      this.processes.delete(terminalId);
      stream?.changed();
      if (!this.pendingKills.get(terminalId)?.has(ptyProcess)) {
        this.gateway.onProcessExit(terminalId);
      }
    });

    return ptyProcess;
  }

  write(terminalId: number, data: string): void {
    const session = this.processes.get(terminalId);
    if (!session) return;
    this.desktopStreams.get(terminalId)?.input(data);
    session.pty.write(data);
  }
  writeBinary(terminalId: number, data: string): void {
    const session = this.processes.get(terminalId);
    if (!session) return;
    this.desktopStreams.get(terminalId)?.input('\x1b');
    session.pty.write(Buffer.from(data, 'latin1'));
  }

  resize(terminalId: number, cols: number, rows: number): void {
    const session = this.processes.get(terminalId);
    if (!session) return;
    if (cols < 2 || rows < 1) return;

    session.pty.resize(cols, rows);
    if (this.desktopStreams.has(terminalId)) this.screens.resize(terminalId, cols, rows);
    this.desktopStreams.get(terminalId)?.resize(cols, rows);

    if (session.useTmux) {
      this.queueTmuxResize(terminalId, session.tmuxSessionName, cols, rows);
    }
  }

  /** Detach the UI without stopping a backend-owned direct PTY. */
  detach(terminalId: number): void {
    const session = this.processes.get(terminalId);
    if (session?.useTmux || (!session && this.tmuxEnabled)) {
      this.kill(terminalId);
    }
  }

  /** Replay before starting/reusing the PTY so subsequent live output follows it. */
  replayOutput(terminalId: number): void {
    const output = this.processes.get(terminalId)?.output;
    if (output) {
      this.gateway.sendToTerminal(terminalId, '\x1bc' + output.snapshot());
    }
  }

  /** End a local direct PTY, or detach from a remote tmux session. */
  kill(terminalId: number): boolean {
    const hadInFlightSpawn = this.spawnInFlight.has(terminalId);
    if (hadInFlightSpawn) {
      this.cancelledSpawns.add(terminalId);
    }
    return this.killProcess(terminalId) || hadInFlightSpawn;
  }

  private killProcess(terminalId: number): boolean {
    const session = this.processes.get(terminalId);

    if (!session) return false;
    session.stopPortDiscovery?.();
    this.desktopStreams.get(terminalId)?.exited(0);
    this.processes.delete(terminalId);
    const cleanup = this.desktopCleanup.get(terminalId);
    this.desktopCleanup.delete(terminalId);
    if (cleanup)
      void cleanup().catch((error) =>
        this.logger.warn(
          `Terminal integration cleanup failed: ${String(error)}`,
        ),
      );
    void this.terminateProcess(terminalId, session.pty, true).catch((error) => {
      this.logger.error(
        `Failed to kill PTY for terminal ${terminalId}: ${error}`,
      );
    });
    return true;
  }

  private terminateProcess(
    terminalId: number,
    process: pty.IPty,
    detach = false,
  ): Promise<void> {
    const retiring = this.pendingKills.get(terminalId) ?? new Set<pty.IPty>();
    retiring.add(process);
    this.pendingKills.set(terminalId, retiring);
    return terminatePtyAndWait(
      process,
      detach ? { signal: 'SIGHUP', graceMs: 5000 } : {},
    ).then(() => {
      retiring.delete(process);
      if (!retiring.size && this.pendingKills.get(terminalId) === retiring) {
        this.pendingKills.delete(terminalId);
      }
    });
  }

  /** Kill both PTY and tmux session — used when deleting a terminal */
  getGeneration(terminalId: number): number {
    return this.generations.get(terminalId) ?? 0;
  }

  async destroy(terminalId: number, requireStopped = false): Promise<boolean> {
    const cleanup = this.desktopCleanup.get(terminalId);
    this.desktopCleanup.delete(terminalId);
    // Retire the process before asynchronous adapter cleanup. An unavailable
    // temporary directory must never keep a shell alive or revive a launch.
    this.generations.set(terminalId, this.getGeneration(terminalId) + 1);
    if (requireStopped) this.strictStops.add(terminalId);
    try {
      if (requireStopped) {
        const pending = this.spawnInFlight.get(terminalId);
        if (pending) {
          this.cancelledSpawns.add(terminalId);
          await pending;
        }
        const session = this.processes.get(terminalId);
        const retiring = new Set(this.pendingKills.get(terminalId));
        if (session) retiring.add(session.pty);
        await Promise.all(
          [...retiring].map((process) =>
            this.terminateProcess(terminalId, process),
          ),
        );
        if (session && this.processes.get(terminalId) === session) {
          session.stopPortDiscovery?.();
          this.processes.delete(terminalId);
        }
      } else this.kill(terminalId);
      this.tmuxResizeState.delete(terminalId);

      if (this.isTmuxAvailable()) {
        const tmuxSessionName = this.getTmuxSessionName(terminalId);
        try {
          await execFileQuiet(this.tmuxBin, [
            'kill-session',
            '-t',
            tmuxSessionName,
          ]);
        } catch (error) {
          if (
            requireStopped &&
            (await this.hasTmuxSessionForTerminal(terminalId))
          )
            throw error;
        }
      }
      this.desktopStreams.get(terminalId)?.exited(0);
      return true;
    } finally {
      if (requireStopped) this.strictStops.delete(terminalId);
      if (cleanup)
        await cleanup().catch(() =>
          this.logger.warn('Terminal integration cleanup failed'),
        );
    }
  }

  forgetDesktop(terminalId: number): void {
    const stream = this.desktopStreams.get(terminalId);
    this.desktopStreams.delete(terminalId);
    stream?.changed();
    this.screens.close(terminalId);
    // Keep the existing cancellation fence: a legacy service can still be
    // awaiting workspace validation before registering its manager spawn.
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
    this.shuttingDown = true;
    this.portDiscovery.dispose();
    this.screens.dispose();
    const ids = new Set([
      ...this.processes.keys(),
      ...this.spawnInFlight.keys(),
    ]);
    for (const terminalId of ids) {
      this.kill(terminalId);
    }
  }

  private async configureTmuxSession(
    tmuxSessionName: string,
    env: NodeJS.ProcessEnv,
    includeHistoryLimit: boolean,
  ): Promise<void> {
    // tmux accepts multiple commands in one invocation, avoiding a process
    // launch for every option on creation and reattachment.
    const commands = [
      ['set-window-option', '-t', tmuxSessionName, 'alternate-screen', 'on'],
      ['set-option', '-t', tmuxSessionName, 'mouse', 'on'],
      ['set-option', '-t', tmuxSessionName, 'status', 'off'],
      ['set-option', '-t', tmuxSessionName, 'focus-events', 'on'],
    ];
    if (includeHistoryLimit) {
      commands.push([
        'set-option',
        '-t',
        tmuxSessionName,
        'history-limit',
        '50000',
      ]);
    }
    const args = commands.flatMap((command, index) =>
      index === 0 ? command : [';', ...command],
    );
    await execFileQuiet(this.tmuxBin, args, { env });
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
