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
import { randomUUID } from 'node:crypto';
import {
  buildAugmentedEnvAsync,
  buildShellCommandArgs,
  buildTmuxInlineEnvPrefix,
  findBinary,
  getDefaultUserShell,
  normalizeShellForPlatform,
} from '../config/system-paths.js';
import { execFileAsync, execFileQuiet } from '../terminal/async-process.js';
import { shouldUseTmux } from '../config/backend-runtime-mode.js';
import { terminatePtyAndWait } from '../terminal/pty-termination.js';
import {
  ACTION_LOG_WRITER,
  ACTION_OUTPUT_CHARS,
  readActionLog,
  readActionLogSnapshot,
  readFileTail,
  removeActionLog,
} from './action-log.js';

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
  flushPending?: Promise<void>;
  stopRequested: boolean;
  useTmux: boolean;
  tmuxSessionName?: string;
  logFilePath?: string;
  launchGatePath?: string;
  finishing?: boolean;
  completion?: Promise<void>;
  finalization?: Promise<void>;
  exitCode?: number;
}
interface ActionPersistence {
  assertCanRun?(actionId: number, worktreePath: string): Promise<void>;
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
const FLUSH_DEBOUNCE_MS = 250;
const COMPLETION_POLL_MS = 300;

@Injectable()
export class ActionPtyManager
  implements OnModuleDestroy, OnApplicationShutdown
{
  private readonly logger = new Logger('ActionPtyManager');
  private readonly processes = new Map<number, RunningAction>();
  private readonly startingActions = new Set<number>();
  private readonly idleClaims = new Map<number, symbol>();
  private readonly monitored = new Set<RunningAction>();
  private completionMonitor?: NodeJS.Timeout;
  private completionCheckInFlight = false;
  private shuttingDown = false;
  private readonly defaultShell = getDefaultUserShell();
  private gateway?: ActionGatewayLike;
  private persistence?: ActionPersistence;
  private readonly tmuxEnabled: boolean;
  private tmuxBin: string;

  constructor() {
    this.tmuxEnabled = shouldUseTmux();
    this.tmuxBin = this.tmuxEnabled ? this.resolveTmuxPath() : '';
  }
  registerGateway(gateway: ActionGatewayLike): void {
    this.gateway = gateway;
  }
  registerPersistence(persistence: ActionPersistence): void {
    this.persistence = persistence;
  }
  isRunning(actionId: number): boolean {
    return this.processes.has(actionId) || this.startingActions.has(actionId);
  }
  /** Exclude startup for the entire async edit/delete operation. */
  reserveIdleAction(actionId: number): (() => void) | null {
    if (this.isRunning(actionId) || this.idleClaims.has(actionId)) return null;
    const claim = Symbol();
    this.idleClaims.set(actionId, claim);
    return () => {
      if (this.idleClaims.get(actionId) === claim)
        this.idleClaims.delete(actionId);
    };
  }
  getCurrentOutput(actionId: number): string {
    return this.processes.get(actionId)?.output ?? '';
  }

  async start(action: ActionRecord): Promise<void> {
    if (this.isRunning(action.id) || this.idleClaims.has(action.id)) {
      throw new Error(`Action ${action.id} is already running`);
    }
    this.assertActive();
    this.startingActions.add(action.id);
    try {
      if (!(await this.pathExists(action.worktreePath))) {
        throw new Error(`Worktree path does not exist: ${action.worktreePath}`);
      }
      if (!this.persistence)
        throw new Error('Action persistence is not registered');
      await this.persistence.assertCanRun?.(action.id, action.worktreePath);
      await this.persistence.markRunning(action.id);
      const env = await this.buildEnv(action.worktreePath);
      await this.persistence.assertCanRun?.(action.id, action.worktreePath);
      this.assertActive();
      // A tmux error can be an ambiguous launch result. Never rerun the command
      // directly after attempting tmux, even if cleanup succeeds.
      if (this.isTmuxAvailable()) await this.spawnWithTmux(action, env);
      else this.spawnDirect(action, env);
      this.gateway?.notifyStatus(action.id, 'running');
    } finally {
      this.startingActions.delete(action.id);
    }
  }

  async stop(actionId: number, requireStopped = false): Promise<boolean> {
    if (this.startingActions.has(actionId)) {
      throw new Error(
        'This action is still starting. Finish the task again after startup settles.',
      );
    }
    const session = this.processes.get(actionId);
    if (!session) {
      if (requireStopped) await this.killTmuxSession(actionId, true);
      return false;
    }
    session.stopRequested = true;
    if (session.useTmux) {
      await this.handleTmuxCompletion(session);
    } else {
      // Shared termination owns this exact PTY and cancels escalation on exit.
      const stopped = terminatePtyAndWait(session.pty).then(() =>
        this.handleExit(session, -1),
      );
      if (requireStopped) await stopped;
      else
        void stopped.catch((error) =>
          this.logger.error(`Failed to stop action ${actionId}: ${error}`),
        );
    }
    return true;
  }

  async reattach(actionId: number, worktreePath: string): Promise<boolean> {
    if (
      this.startingActions.has(actionId) ||
      this.idleClaims.has(actionId) ||
      this.shuttingDown
    )
      return false;
    if (this.isRunning(actionId)) return true;
    this.startingActions.add(actionId);
    const tmuxSessionName = this.getTmuxSessionName(actionId);
    try {
      if (!(await this.tmuxSessionExists(tmuxSessionName))) return false;
      const logFilePath = this.getLogFilePath(actionId);
      const env = await this.buildEnv(worktreePath);
      this.assertActive();
      const { stdout: pipeState } = await execFileAsync(this.tmuxBin, [
        'display-message',
        '-p',
        '-t',
        tmuxSessionName,
        '#{pane_pipe}\t#{pane_dead}',
      ]);
      const [piped, dead] = pipeState.trim().split('\t');
      // pipe-pane -o toggles an existing pipe OFF. Preserve the writer and its
      // rotation/drain state across backend restart instead of toggling it.
      if (piped !== '1' && dead !== '1') {
        await fs.unlink(`${logFilePath}.ready`).catch(() => undefined);
        await fs.unlink(`${logFilePath}.done`).catch(() => undefined);
        await execFileQuiet(this.tmuxBin, [
          'pipe-pane',
          '-t',
          tmuxSessionName,
          this.logPipeCommand(logFilePath),
        ]);
        if (!(await this.waitForFile(`${logFilePath}.ready`)))
          throw new Error('Action log writer did not start');
      }
      const snapshot = await readActionLogSnapshot(logFilePath).catch(() => ({
        output: '',
        endOffset: 0,
      }));
      this.assertActive();
      const running = this.followLog(
        actionId,
        worktreePath,
        env,
        logFilePath,
        ['-c', `+${snapshot.endOffset + 1}`, '-F', logFilePath],
        snapshot.output,
      );
      this.startCompletionMonitor(running);
      if (snapshot.output) this.scheduleFlush(running);
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to reattach to tmux session ${tmuxSessionName}: ${error}`,
      );
      return false;
    } finally {
      this.startingActions.delete(actionId);
    }
  }

  hasTmuxSessionForAction(actionId: number): Promise<boolean> {
    return this.tmuxSessionExists(this.getTmuxSessionName(actionId));
  }
  async killTmuxSession(
    actionId: number,
    requireStopped = false,
  ): Promise<void> {
    if (!this.isTmuxAvailable()) return;
    try {
      await execFileQuiet(this.tmuxBin, [
        'kill-session',
        '-t',
        this.getTmuxSessionName(actionId),
      ]);
    } catch (error) {
      if (await this.hasTmuxSessionForAction(actionId)) {
        if (requireStopped) throw error;
        return;
      }
    }
    const log = this.getLogFilePath(actionId);
    await this.waitForLogDrain(log);
    await removeActionLog(log);
    await fs.unlink(this.getExitCodePath(actionId)).catch(() => undefined);
  }

  private assertActive(): void {
    if (this.shuttingDown) throw new Error('Action manager is shutting down');
  }
  private resolveTmuxPath(): string {
    return findBinary('tmux') ?? '';
  }
  private isTmuxAvailable(): boolean {
    if (!this.tmuxEnabled) return false;
    if (!this.tmuxBin) this.tmuxBin = this.resolveTmuxPath();
    return this.tmuxBin !== '';
  }
  private getTmuxSessionName(id: number): string {
    return `elevenex-action-${id}`;
  }
  private getExitCodePath(id: number): string {
    return path.join(os.tmpdir(), `elevenex-action-${id}.exitcode`);
  }
  private getLogFilePath(id: number): string {
    return path.join(os.tmpdir(), `elevenex-action-${id}.log`);
  }
  private async tmuxSessionExists(name: string): Promise<boolean> {
    if (!this.isTmuxAvailable()) return false;
    try {
      await execFileQuiet(this.tmuxBin, ['has-session', '-t', name]);
      return true;
    } catch {
      return false;
    }
  }
  private async readExitCode(id: number): Promise<number | null> {
    const file = this.getExitCodePath(id);
    try {
      const content = (await readFileTail(file, 64)).toString('utf8').trim();
      await fs.unlink(file).catch(() => undefined);
      const code = parseInt(content, 10);
      return Number.isFinite(code) ? code : null;
    } catch {
      return null;
    }
  }
  private shellEscape(cmd: string): string {
    return `'${cmd.replace(/'/g, "'\\''")}'`;
  }
  private async pathExists(file: string): Promise<boolean> {
    try {
      await fs.access(file);
      return true;
    } catch {
      return false;
    }
  }
  private async buildEnv(worktreePath: string): Promise<NodeJS.ProcessEnv> {
    return {
      ...(await buildAugmentedEnvAsync(process.env, worktreePath)),
      PWD: worktreePath,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };
  }
  private resolveShell(env: NodeJS.ProcessEnv): string {
    return normalizeShellForPlatform(env.SHELL || this.defaultShell);
  }
  private logPipeCommand(log: string): string {
    return `ELECTRON_RUN_AS_NODE=1 ${this.shellEscape(process.execPath)} -e ${this.shellEscape(ACTION_LOG_WRITER)} ${this.shellEscape(log)}`;
  }
  private async waitForFile(file: string, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      if (await this.pathExists(file)) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    return false;
  }
  private async waitForLogDrain(log: string): Promise<void> {
    // Legacy cat pipes have no marker; reads are still bounded for those logs.
    if (await this.pathExists(`${log}.ready`)) {
      if (!(await this.waitForFile(`${log}.done`))) {
        this.logger.warn(`Timed out draining action log ${log}`);
      }
    }
  }

  private async spawnWithTmux(
    action: ActionRecord,
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const name = this.getTmuxSessionName(action.id);
    const log = this.getLogFilePath(action.id);
    const exit = this.getExitCodePath(action.id);
    const gate = `${log}.launch-${randomUUID()}`;
    let attempted = false;
    let setupSucceeded = false;
    let running: RunningAction | undefined;
    try {
      if (await this.tmuxSessionExists(name))
        await this.killTmuxSession(action.id, true);
      await removeActionLog(log);
      await fs.unlink(exit).catch(() => undefined);
      await fs.writeFile(log, '');
      const prefix = buildTmuxInlineEnvPrefix(env, { mode: 'full' });
      const inner = `${prefix} ${this.shellEscape(this.resolveShell(env))} -lc ${this.shellEscape(action.command)}; echo $? > ${this.shellEscape(exit)}`;
      // No user command can run until options, the bounded pipe, and tail are
      // ready. A backend crash during setup cannot leave an eternal gate waiter.
      const gated = `i=0; while [ ! -f ${this.shellEscape(gate)} ]; do i=$((i+1)); [ "$i" -lt 600 ] || exit 125; sleep 0.05; done; rm -f ${this.shellEscape(gate)}; ${inner}`;
      attempted = true;
      await execFileQuiet(
        this.tmuxBin,
        [
          'new-session',
          '-d',
          '-s',
          name,
          '-c',
          action.worktreePath,
          '-x',
          '120',
          '-y',
          '32',
          `/bin/sh -c ${this.shellEscape(gated)}`,
        ],
        { env: { ...env, TERM: 'xterm-256color' } },
      );
      await execFileQuiet(this.tmuxBin, [
        'set-option',
        '-t',
        name,
        'status',
        'off',
        ';',
        'set-option',
        '-t',
        name,
        'history-limit',
        '50000',
        ';',
        'set-option',
        '-t',
        name,
        'remain-on-exit',
        'on',
        ';',
        'pipe-pane',
        '-t',
        name,
        '-o',
        this.logPipeCommand(log),
      ]);
      if (!(await this.waitForFile(`${log}.ready`)))
        throw new Error('Action log writer did not start');
      this.assertActive();
      running = this.followLog(action.id, action.worktreePath, env, log, [
        '-c',
        '+1',
        '-F',
        log,
      ]);
      // Once release is attempted the command may have executed, even when the
      // filesystem operation reports an error. The catch never falls back.
      running.launchGatePath = gate;
      await fs.writeFile(gate, '');
      this.startCompletionMonitor(running);
      setupSucceeded = true;
    } catch (error) {
      if (running) {
        running.finishing = true;
        clearTimeout(running.flushTimer ?? undefined);
        running.flushTimer = null;
        this.stopCompletionMonitor(running);
        await terminatePtyAndWait(running.pty).catch((e) =>
          this.logger.error(e),
        );
      }
      if (attempted) {
        await this.killTmuxSession(action.id, true);
      } else {
        await removeActionLog(log);
      }
      if (running) await running.flushPending;
      if (running && this.processes.get(action.id) === running)
        this.processes.delete(action.id);
      this.logger.error(`Failed to create tmux session ${name}: ${error}`);
      throw error;
    } finally {
      // On success the waiting shell owns removal. Unlinking here could make
      // a short-lived release invisible between its polling iterations.
      if (!setupSucceeded) await fs.unlink(gate).catch(() => undefined);
    }
  }

  private followLog(
    id: number,
    cwd: string,
    env: NodeJS.ProcessEnv,
    log: string,
    args: string[],
    output = '',
  ): RunningAction {
    const process = pty.spawn('tail', args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd,
      env,
    });
    const session: RunningAction = {
      id,
      pty: process,
      output,
      flushTimer: null,
      stopRequested: false,
      useTmux: true,
      tmuxSessionName: this.getTmuxSessionName(id),
      logFilePath: log,
    };
    this.registerOutput(session);
    return session;
  }
  private spawnDirect(action: ActionRecord, env: NodeJS.ProcessEnv): void {
    const shell = this.resolveShell(env);
    const process = pty.spawn(
      shell,
      buildShellCommandArgs(shell, action.command),
      {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd: action.worktreePath,
        env,
      },
    );
    const session: RunningAction = {
      id: action.id,
      pty: process,
      output: '',
      flushTimer: null,
      stopRequested: false,
      useTmux: false,
    };
    this.registerOutput(session);
    process.onExit(({ exitCode }) => {
      void this.handleExit(session, exitCode).catch((error) =>
        this.logger.error(`Failed to finalize action ${session.id}: ${error}`),
      );
    });
  }
  private registerOutput(session: RunningAction): void {
    this.processes.set(session.id, session);
    session.pty.onData((data) => {
      if (this.processes.get(session.id) !== session || session.finishing)
        return;
      session.output = (session.output + data).slice(-ACTION_OUTPUT_CHARS);
      this.gateway?.sendToAction(session.id, data);
      this.scheduleFlush(session);
    });
  }

  private startCompletionMonitor(session: RunningAction): void {
    this.monitored.add(session);
    this.completionMonitor ??= setInterval(() => {
      void this.pollCompletions();
    }, COMPLETION_POLL_MS);
  }
  private stopCompletionMonitor(session: RunningAction): void {
    this.monitored.delete(session);
    if (!this.monitored.size) {
      clearInterval(this.completionMonitor);
      this.completionMonitor = undefined;
    }
  }
  private async pollCompletions(): Promise<void> {
    if (this.completionCheckInFlight || this.shuttingDown) return;
    this.completionCheckInFlight = true;
    const snapshot = [...this.monitored];
    try {
      // One server snapshot per tick for every action; overlapping ticks coalesce.
      const { stdout } = await execFileAsync(this.tmuxBin, [
        'list-panes',
        '-a',
        '-F',
        '#{session_name}\t#{pane_dead}',
      ]).catch((error) => {
        if (
          /no server running|no sessions|error connecting to .*\(No such file or directory\)/.test(
            String(error.stderr ?? ''),
          )
        ) {
          return { stdout: '', stderr: '' };
        }
        throw error;
      });
      const live = new Set<string>();
      for (const line of stdout.split('\n')) {
        const [name, dead] = line.split('\t');
        if (dead === '0') live.add(name);
      }
      for (const session of snapshot) {
        if (
          this.processes.get(session.id) !== session ||
          !this.monitored.has(session)
        )
          continue;
        if (!live.has(session.tmuxSessionName!)) {
          void this.handleTmuxCompletion(session).catch((error) =>
            this.logger.error(
              `Failed to complete action ${session.id}: ${error}`,
            ),
          );
        }
      }
    } catch (error) {
      // Connection failures are not evidence that an action has finished.
      this.logger.debug(`Could not poll action panes: ${error}`);
    } finally {
      this.completionCheckInFlight = false;
    }
  }

  private async terminateTmuxPane(session: RunningAction): Promise<void> {
    const inspect = async () => {
      try {
        const { stdout } = await execFileAsync(
          this.tmuxBin,
          [
            'display-message',
            '-p',
            '-t',
            session.tmuxSessionName!,
            '#{pane_pid}\t#{pane_dead}',
          ],
          { timeout: 2000 },
        );
        const [pid, dead] = stdout.trim().split('\t');
        return { pid: Number(pid), dead: dead === '1' };
      } catch (error) {
        if (!(await this.tmuxSessionExists(session.tmuxSessionName!)))
          return null;
        throw error;
      }
    };
    let pane = await inspect();
    if (!pane || pane.dead) return;
    const pid = pane.pid;
    if (!Number.isSafeInteger(pid) || pid <= 1)
      throw new Error('Could not identify action pane process');
    const signal = (name: NodeJS.Signals) => {
      // tmux panes are session/process-group leaders. Signal the captured group,
      // leaving tmux alive to drain the PTY and pipe instead of discarding them.
      try {
        process.kill(process.platform === 'win32' ? pid : -pid, name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };
    const started = Date.now();
    let escalated = false;
    signal('SIGTERM');
    while (pane && !pane.dead) {
      if (pane.pid !== pid || this.processes.get(session.id) !== session)
        throw new Error('Action pane changed during stop');
      if (!escalated && Date.now() - started >= 1500) {
        signal('SIGKILL');
        escalated = true;
      }
      if (Date.now() - started >= 7000)
        throw new Error(
          'The action did not stop. Its environment is still reserved.',
        );
      await new Promise((resolve) => setTimeout(resolve, 50));
      pane = await inspect();
    }
  }

  private handleTmuxCompletion(session: RunningAction): Promise<void> {
    if (session.completion) return session.completion;
    if (this.processes.get(session.id) !== session) return Promise.resolve();
    session.finishing = true;
    this.stopCompletionMonitor(session);
    const pending = (async () => {
      if (session.stopRequested) await this.terminateTmuxPane(session);
      // pane_dead confirms tmux drained the pane and pipe buffers. Removing
      // the session now supplies EOF even on versions retaining a dead pipe.
      try {
        await execFileQuiet(this.tmuxBin, [
          'kill-session',
          '-t',
          session.tmuxSessionName!,
        ]);
      } catch (error) {
        if (await this.tmuxSessionExists(session.tmuxSessionName!)) throw error;
      }
      await this.waitForLogDrain(session.logFilePath!);
      await terminatePtyAndWait(session.pty);
      session.output = await readActionLog(session.logFilePath!).catch(
        () => session.output,
      );
      const exitCode = (await this.readExitCode(session.id)) ?? -1;
      await removeActionLog(session.logFilePath!);
      if (session.launchGatePath)
        await fs.unlink(session.launchGatePath).catch(() => undefined);
      await this.handleExit(session, exitCode);
    })();
    session.completion = pending;
    void pending.catch(() => {
      session.completion = undefined;
      if (!session.finalization && this.processes.get(session.id) === session) {
        session.finishing = false;
        this.startCompletionMonitor(session);
      }
    });
    return pending;
  }

  private scheduleFlush(session: RunningAction): void {
    if (session.flushTimer || session.finishing) return;
    session.flushTimer = setTimeout(() => {
      session.flushTimer = null;
      if (this.processes.get(session.id) === session && !session.finishing)
        this.flushCurrentOutput(session);
    }, FLUSH_DEBOUNCE_MS);
  }
  private flushCurrentOutput(session: RunningAction): void {
    if (!this.persistence) return;
    const output = session.output;
    session.flushPending = (session.flushPending ?? Promise.resolve())
      .then(() => this.persistence!.flushCurrentOutput(session.id, output))
      .catch((error) =>
        this.logger.error(`Failed to flush action ${session.id}: ${error}`),
      );
  }
  private handleExit(session: RunningAction, exitCode: number): Promise<void> {
    if (session.finalization) return session.finalization;
    if (this.processes.get(session.id) !== session || !this.persistence)
      return Promise.resolve();
    session.exitCode ??= exitCode;
    session.finishing = true;
    clearTimeout(session.flushTimer ?? undefined);
    session.flushTimer = null;
    const pending = (async () => {
      // A delayed debounced write must never overwrite the final persisted row.
      await session.flushPending;
      const now = new Date().toISOString();
      const status: ActionStatus = session.stopRequested
        ? 'stopped'
        : session.exitCode === 0
          ? 'success'
          : 'failed';
      await this.persistence!.finalizeRun(session.id, {
        status,
        currentOutput: '',
        lastOutput: session.output,
        lastExitCode: Number.isFinite(session.exitCode)
          ? session.exitCode!
          : null,
        lastFinishedAt: now,
        updatedAt: now,
      });
      if (this.processes.get(session.id) === session) {
        this.processes.delete(session.id);
        this.gateway?.notifyStatus(session.id, status);
      }
    })();
    session.finalization = pending;
    void pending.catch(() => {
      session.finalization = undefined;
    });
    return pending;
  }

  onModuleDestroy(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    clearInterval(this.completionMonitor);
    this.completionMonitor = undefined;
    this.monitored.clear();
    for (const session of this.processes.values()) {
      clearTimeout(session.flushTimer ?? undefined);
      if (!session.finishing && session.output)
        this.flushCurrentOutput(session);
      session.finishing = true;
      // tmux survives restart; only its follower is terminated here.
      void terminatePtyAndWait(session.pty).catch((error) =>
        this.logger.error(error),
      );
    }
    this.processes.clear();
  }
  onApplicationShutdown(): void {
    this.onModuleDestroy();
  }
}
