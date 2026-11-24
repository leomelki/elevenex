import { Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import type { TaskAppInput, TaskAppRun } from '@elevenex/shared';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { appDisplaySize, type AppDisplaySize } from './app-display-size.js';
import { appRunDirectory, TaskAppJournal } from './task-app-journal.js';
import { RuntimeVideoHost } from '../desktop-browser/runtime-video-host.js';
import { hostInput } from './app-input.js';
import { DisplayCapture, type AppFrameListener } from './display-capture.js';
import { androidArguments } from './android-app.js';

import { DarwinAppDisplay } from './darwin-display.js';
import { WindowsAppDisplay } from './windows-display.js';
import {
  spawnAppSupervisor,
  launchFingerprint,
  validLaunch,
  type AppLaunch,
} from './app-launch.js';
export { appEnvironment, type AppLaunch } from './app-launch.js';
const LOG_LIMIT = 32_768;
const MAX_HISTORY = 128;
const MAX_ACTIVE = 16;

interface AppRunResult {
  status: 'stopped' | 'success' | 'failed';
  output: string;
  exitCode: number | null;
}
export interface AppRunObserver {
  output(chunk: string): void;
  finished(result: AppRunResult): Promise<void>;
}

interface LaunchAuthority {
  sessionId: number;
  checkoutToken: string;
}
interface PendingLaunch extends LaunchAuthority {
  launch: AppLaunch;
}
interface Run {
  readonly displaySize: AppDisplaySize;
  readonly waiters: Set<(state: TaskAppRun) => void>;
  readonly lifetime: AbortController;
  readonly savedActionId?: number;
  observer?: AppRunObserver;
  outcome?: AppRunResult;
  proposal?: { value: PendingLaunch; expires: number; timer: NodeJS.Timeout };
  state: TaskAppRun;
  identity: string;
  specification: string;
  log: string;
  directory?: string;
  child?: ChildProcess;
  capture?: DisplayCapture | DarwinAppDisplay | WindowsAppDisplay;
  viewers: number;
  control?: { viewer: string; timer: NodeJS.Timeout };
  setup?: Promise<void>;
  shutdown?: Promise<void>;
  exited?: Promise<void>;
  closing?: Promise<void>;
  stopped: boolean;
  cleaned: boolean;
  exitCode?: number;
  failure?: string;
}

@Injectable()
export class TaskAppHost implements OnModuleDestroy {
  private readonly runs = new Map<string, Run>();
  private readonly videoHost: RuntimeVideoHost;
  constructor(
    @Optional() private readonly sharedVideoHost?: RuntimeVideoHost,
    @Optional() private readonly journal?: TaskAppJournal,
  ) {
    this.videoHost = sharedVideoHost ?? new RuntimeVideoHost();
  }
  private shuttingDown = false;
  private handoffUntil = 0;

  beginRuntimeHandoff(): number {
    const active = [...this.runs.values()].filter(
      (run) => !run.cleaned && !run.proposal,
    ).length + (this.journal?.recoveryCount() ?? 0);
    if (!active) this.handoffUntil = performance.now() + 30_000;
    return active;
  }

  async start(
    request: AppLaunch,
    observer?: AppRunObserver,
  ): Promise<TaskAppRun> {
    return this.reserve(request, undefined, observer);
  }

  propose(request: AppLaunch, authority: LaunchAuthority): TaskAppRun {
    if (
      !Number.isSafeInteger(authority.sessionId) ||
      authority.sessionId <= 0 ||
      !authority.checkoutToken ||
      authority.checkoutToken.length > 4096
    )
      throw new Error('Invalid app launch authority');
    return this.reserve(request, authority);
  }

  pending(taskId: number, runId: string): PendingLaunch {
    const run = this.owned(taskId, runId);
    if (run.proposal && run.proposal.expires <= Date.now())
      this.dismiss(run, 'Launch request expired');
    if (!run.proposal) throw new Error('App launch request is unavailable');
    return run.proposal.value;
  }

  approve(
    taskId: number,
    runId: string,
    observer?: AppRunObserver,
  ): TaskAppRun {
    const run = this.owned(taskId, runId);
    const { launch } = this.pending(taskId, runId);
    this.checkCapacity(taskId);
    this.journal?.approve(runId);
    clearTimeout(run.proposal!.timer);
    run.proposal = undefined;
    const { pendingLaunch, ...previous } = run.state;
    this.updateRun(run, { ...previous, status: 'starting' });
    this.begin(run, launch, observer);
    return run.state;
  }

  private dismiss(run: Run, detail: string): void {
    if (!run.proposal) return;
    this.journal?.finish(run.state.runId, detail === 'Launch request expired' ? 'expired' : 'cancelled');
    clearTimeout(run.proposal.timer);
    run.proposal = undefined;
    const { pendingLaunch, ...previous } = run.state;
    this.updateRun(run, { ...previous, status: 'exited', detail });
    run.cleaned = true;
  }

  private checkCapacity(taskId: number): void {
    if (this.shuttingDown || performance.now() < this.handoffUntil)
      throw new Error('App host is preparing a runtime update');
    const active = [...this.runs.values()].filter(
      (run) => !run.cleaned && !run.proposal,
    );
    if (this.count(taskId) >= 4 || active.length + (this.journal?.recoveryCount() ?? 0) >= MAX_ACTIVE)
      throw new Error(
        'App run limit reached. Stop a running app and try again.',
      );
  }

  existing(request: AppLaunch): TaskAppRun | undefined {
    const identity = JSON.stringify([request.taskId, request.requestId]);
    const existing = [...this.runs.values()].find(
      (run) => run.identity === identity,
    );
    if (existing && existing.specification !== launchFingerprint(request))
      throw new Error('Launch request ID was reused for a different app');
    return existing?.state ?? this.journal?.lookup(request);
  }

  private reserve(
    original: AppLaunch,
    authority?: LaunchAuthority,
    observer?: AppRunObserver,
  ): TaskAppRun {
    const request = Object.freeze({
      ...original,
      ...(original.virtualDisplay ? { virtualDisplay: Object.freeze({ ...original.virtualDisplay }) } : {}),
      ...(original.savedAction
        ? { savedAction: Object.freeze({ ...original.savedAction }) }
        : {}),
      args: Object.freeze([...original.args]),
      ...(original.android
        ? { android: Object.freeze({ ...original.android }) }
        : {}),
    });
    validLaunch(request);
    if (this.shuttingDown) throw new Error('App host is shutting down');
    const existing = this.existing(request);
    if (existing) return existing;
    const identity = JSON.stringify([request.taskId, request.requestId]);
    const specification = launchFingerprint(request);
    if (authority) {
      const requested = [...this.runs.values()].filter((run) => run.proposal);
      if (
        requested.length >= 32 ||
        requested.filter((run) => run.state.taskId === request.taskId).length >=
          4
      )
        throw new Error('Too many pending app launches');
    } else this.checkCapacity(request.taskId);
    while (this.runs.size >= MAX_HISTORY) {
      const completed = [...this.runs.values()].find((run) => run.cleaned);
      if (!completed) throw new Error('App run limit reached');
      this.runs.delete(completed.state.runId);
    }
    const state: TaskAppRun = {
      runId: randomUUID(),
      taskId: request.taskId,
      name: request.name,
      mode: request.mode,
      status: authority ? 'requested' : 'starting',
      ...(authority
        ? {
            pendingLaunch: {
              executable: request.executable,
              args: request.android
                ? androidArguments(
                    request.android.avd,
                    '<private run directory>/avd-data',
                  )
                : request.args,
            },
          }
        : {}),
      startedAt: Date.now(),
    };
    const receipt = this.journal?.reserve(request, state);
    if (receipt) return receipt;
    const run: Run = {
      waiters: new Set(),
      displaySize: appDisplaySize(request),
      state,
      lifetime: new AbortController(),
      savedActionId: request.savedAction?.id,
      identity,
      specification,
      log: '',
      viewers: 0,
      stopped: false,
      cleaned: false,
    };
    this.runs.set(state.runId, run); // reserve before the first await, including launch retries
    if (authority) {
      const timer = setTimeout(
        () => { try { this.dismiss(run, 'Launch request expired'); } catch { /* pending() retries durable expiration before approval. */ } },
        600_000,
      );
      timer.unref();
      run.proposal = {
        timer,
        expires: Date.now() + 600_000,
        value: Object.freeze({ launch: request, ...authority }),
      };
    } else this.begin(run, request, observer);
    return run.state;
  }

  private begin(run: Run, request: AppLaunch, observer?: AppRunObserver): void {
    run.observer = observer;
    run.setup = this.launch(run, request).catch(async (error: unknown) => {
      run.failure =
        error instanceof Error
          ? error.message.slice(0, 320)
          : 'App launch failed';
      if (run.child) {
        this.terminate(run);
        await run.exited;
      } else await this.finish(run).catch(() => undefined);
    });
  }

  list(taskId: number): TaskAppRun[] {
    const runs = new Map(this.journal?.list(taskId).map(state => [state.runId, state]));
    for (const run of this.runs.values()) if (run.state.taskId === taskId) runs.set(run.state.runId, run.state);
    // A long-running app stays reachable while short-lived development runs finish.
    const active = (state: TaskAppRun) => state.status !== 'failed' && state.status !== 'exited';
    return [...runs.values()].sort((a, b) => Number(active(b)) - Number(active(a)) || b.startedAt - a.startedAt).slice(0, MAX_HISTORY);
  }

  private owned(taskId: number, id: string): Run {
    const run = this.runs.get(id);
    if (!run || run.state.taskId !== taskId)
      throw new Error('App run is unavailable for this task');
    return run;
  }

  private updateRun(run: Run, state: TaskAppRun): void {
    const changed = run.state.status !== state.status;
    run.state = state;
    if (changed) for (const wake of run.waiters) wake(state);
  }

  /** Await a lifecycle transition without repeated API reads or frame observers. */
  waitForChange(taskId: number, id: string, after: TaskAppRun['status'], timeoutMs: number, signal: AbortSignal): Promise<TaskAppRun> {
    signal.throwIfAborted();
    const state = this.get(taskId, id);
    const run = this.runs.get(id);
    if (!run || run.cleaned || state.status !== after || state.status === 'failed' || state.status === 'exited')
      return Promise.resolve(state);
    if (run.waiters.size >= 16) throw new Error('Too many waiters for this app run.');
    return new Promise((resolve, reject) => {
      const finish = (state: TaskAppRun) => { cleanup(); resolve(state); };
      const abort = () => { cleanup(); reject(signal.reason); };
      const timer = setTimeout(() => finish(run.state), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        run.waiters.delete(finish);
        signal.removeEventListener('abort', abort);
      };
      run.waiters.add(finish);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  get(taskId: number, id: string): TaskAppRun {
    const run = this.runs.get(id);
    if (run?.state.taskId === taskId) return run.state;
    const receipt = this.journal?.get(taskId, id);
    if (receipt) return receipt;
    throw new Error('App run is unavailable for this task');
  }
  output(taskId: number, id: string): string {
    const run = this.runs.get(id);
    if (run?.state.taskId === taskId) return run.log;
    this.get(taskId, id);
    return 'Output is no longer available from the original app run.';
  }

  count(taskId: number, excludeSavedActions = false): number {
    let total = this.journal?.recoveryCount(taskId) ?? 0;
    for (const run of this.runs.values())
      if (
        run.state.taskId === taskId &&
        !run.cleaned &&
        !run.proposal &&
        (!excludeSavedActions || !run.savedActionId)
      )
        total++;
    return total;
  }

  private async launch(run: Run, request: AppLaunch): Promise<void> {
    const directory = appRunDirectory(run.state.runId);
    await mkdir(directory, { mode: 0o700 });
    run.directory = directory;
    if (run.stopped) return this.finish(run);
    const { child, linuxLaunch } = await spawnAppSupervisor(
      request,
      run.state.runId,
      run.directory,
      run.lifetime.signal,
      !!this.journal,
    );
    run.child = child;
    for (const output of process.platform === 'win32'
      ? [child.stderr]
      : [child.stdout, child.stderr]) {
      output?.setEncoding('utf8');
      output?.on('data', (chunk: string) => {
        const tail = chunk.slice(-LOG_LIMIT);
        run.log = (run.log + tail).slice(-LOG_LIMIT);
        try {
          run.observer?.output(tail);
        } catch {
          /* final snapshot replaces partial log delivery */
        }
      });
    }
    child.once('error', (error) => {
      run.failure = error.message.slice(0, 320);
    });
    run.exited = new Promise<void>((resolve) => {
      child.once('close', (code, signal) => {
        run.child = undefined;
        run.exitCode ??= code ?? (signal ? 1 : 0);
        // stop() may retry a transient scratch-directory cleanup failure after
        // the process has exited, e.g. while Windows releases a file handle.
        void this.finish(run)
          .catch(() => undefined)
          .finally(resolve);
      });
    });
    if (process.platform !== 'win32') {
      let text = '';
      const channel = child.stdio[3];
      if (!(channel instanceof Readable))
        throw new Error('App supervisor control pipe missing');
      channel.setEncoding('utf8');
      channel.on('data', (chunk: string) => {
        text += chunk;
        const messages = text.split('\n');
        text = messages.pop()!;
        try {
          if (text.length > 4096)
            throw new Error('Invalid app supervisor reply');
          for (const message of messages)
            this.receive(run, JSON.parse(message));
        } catch {
          run.failure = 'Invalid app supervisor reply';
          child.stdin?.end();
        }
      });
      child.stdin?.on('error', () => undefined);
    } else {
      let reply = '';
      let supervisorExited = false;
      child.once('exit', () => {
        supervisorExited = true;
        // The view holds a query handle on the job. Closing it on process
        // exit lets Windows terminate job members that still hold stdio pipes.
        run.capture?.close('App exited');
        run.capture = undefined;
      });
      child.stdin?.on('error', () => undefined);
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        reply += chunk;
        if (reply.trim() === 'ready' && !run.stopped && !supervisorExited) {
          if (run.state.mode === 'stream')
            run.capture = new WindowsAppDisplay(
              run.state.runId,
              this.videoHost,
            );
          this.updateRun(run, { ...run.state, status: 'running' });
        } else if (reply.length > 128) child.stdin?.end();
      });
    }
    // Every platform waits on stdin before creating any user process. Persist
    // the real supervisor birth identity, then grant only if still the owner.
    if (!child.pid) throw new Error('The app supervisor could not start.');
    if (this.journal) await this.journal.grant(run.state.runId, child.pid);
    if (run.stopped || run.lifetime.signal.aborted || run.child !== child) return;
    child.stdin!.write(linuxLaunch ? JSON.stringify(linuxLaunch) + '\n' : 'GO\n');
  }

  private receive(
    run: Run,
    message: {
      kind: string;
      display?: string;
      authority?: string;
      message?: string;
      code?: number;
    },
  ): void {
    if (message.kind === 'error') {
      run.failure = (message.message ?? 'App host failed').slice(0, 320);
      return;
    }
    if (message.kind === 'exit') {
      run.exitCode = message.code;
      return;
    }
    if (message.kind !== 'ready' || run.stopped) return;
    if (
      run.state.mode === 'stream' &&
      process.platform === 'darwin' &&
      run.child
    ) {
      run.capture = new DarwinAppDisplay(run.child);
    } else if (run.state.mode === 'stream') {
      if (
        !message.display ||
        !/^:\d{1,6}$/.test(message.display) ||
        !message.authority ||
        !isAbsolute(message.authority)
      )
        throw new Error('Invalid private app display');
      run.capture = DisplayCapture.x11(
        message.display,
        message.authority,
        this.videoHost,
        run.displaySize,
      );
    }
    this.updateRun(run, { ...run.state, status: 'running' });
  }

  watch(taskId: number, id: string, listener: AppFrameListener): () => void {
    const run = this.owned(taskId, id);
    if (run.state.status !== 'running' || !run.capture)
      throw new Error('App stream is unavailable');
    if (
      !run.viewers &&
      [...this.runs.values()].filter((other) => other.viewers).length >= 4
    )
      throw new Error('Host video capacity reached');
    let detached = false;
    const decrement = () => {
      if (!detached) {
        detached = true;
        run.viewers--;
      }
    };
    const close = run.capture.watch({
      frame: (frame) => listener.frame(frame),
      end: (reason, disposition) => {
        decrement();
        listener.end(reason, disposition);
      },
    });
    run.viewers++;
    return () => {
      close();
      decrement();
    };
  }

  acquireInput(taskId: number, id: string, viewer: string): void {
    const run = this.owned(taskId, id);
    if (
      !viewer ||
      run.state.status !== 'running' ||
      !run.capture ||
      !run.viewers
    )
      throw new Error('App is unavailable for control');
    if (run.control) {
      if (run.control.viewer !== viewer) throw new Error('Another viewer is controlling this app');
      return;
    }
    const timer = setTimeout(() => {
      void this.releaseInput(taskId, id, viewer).catch(() => undefined);
    }, 30_000);
    timer.unref();
    run.control = { viewer, timer };
  }

  private write(run: Run, message: object, release = false): Promise<void> {
    const input = run.child?.stdin;
    if (
      !input?.writable ||
      input.writableEnded ||
      (!release && input.writableLength >= 32768)
    )
      return Promise.reject(new Error('App input is unavailable'));
    return new Promise((resolve, reject) =>
      input.write(JSON.stringify(message) + '\n', (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }

  async input(
    taskId: number,
    id: string,
    viewer: string,
    event: TaskAppInput,
  ): Promise<void> {
    const run = this.owned(taskId, id);
    if (run.control?.viewer !== viewer || run.state.status !== 'running')
      throw new Error('App control has expired');
    run.control.timer.refresh();
    if (run.capture && 'input' in run.capture) await run.capture.input(event);
    else await this.write(run, hostInput(event, run.displaySize));
  }

  async releaseInput(
    taskId: number,
    id: string,
    viewer: string,
  ): Promise<void> {
    const run = this.owned(taskId, id);
    if (run.control?.viewer !== viewer) return;
    clearTimeout(run.control.timer);
    run.control = undefined;
    if (run.capture && 'input' in run.capture)
      await run.capture.input({ kind: 'release' });
    else await this.write(run, { kind: 'release' }, true);
  }

  private terminate(run: Run): void {
    const child = run.child;
    if (!child?.pid) return;
    child.stdin?.end(); // EOF drains the platform-owned job or process group.
  }

  async stop(taskId: number, id: string): Promise<TaskAppRun> {
    if (!this.runs.has(id)) {
      if (!this.journal?.get(taskId, id)) throw new Error('App run is unavailable for this task');
      await this.journal.drain(taskId, id);
      return this.get(taskId, id);
    }
    const run = this.owned(taskId, id);
    if (run.proposal) this.dismiss(run, 'Launch request cancelled');
    if (run.cleaned) return run.state;
    run.stopped = true;
    run.lifetime.abort();
    this.updateRun(run, { ...run.state, status: 'stopping' });
    run.shutdown ??= (async () => {
      await run.setup;
      this.terminate(run);
      if (run.exited) {
        let timeout: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            run.exited,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error('App processes are still stopping')),
                10_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
      }
      await this.finish(run);
    })().finally(() => {
      run.shutdown = undefined;
    });
    await run.shutdown;
    return run.state;
  }

  private finish(run: Run): Promise<void> {
    run.closing ??= (async () => {
      if (run.control) clearTimeout(run.control.timer);
      run.control = undefined;
      run.capture?.close('App exited');
      run.capture = undefined;
      await this.journal?.readyToClean(run.state.runId);
      if (run.directory)
        await rm(run.directory, {
          recursive: true,
          force: true,
          maxRetries: 3,
        });
      run.outcome ??= {
        status: run.stopped ? 'stopped' : run.failure || run.exitCode ? 'failed' : 'success',
        output: run.log, exitCode: run.exitCode ?? null,
      };
      const { status } = run.outcome;
      if (run.observer) {
        await run.observer.finished(run.outcome);
        run.observer = undefined;
      }
      this.journal?.finish(run.state.runId, status === 'success' ? 'exited' : status);
      run.cleaned = true;
      this.updateRun(run, {
        ...run.state,
        status: status === 'failed' ? 'failed' : 'exited',
        detail: status === 'stopped'
          ? 'Stopped'
          : (run.failure ?? 'Exited with code ' + (run.exitCode ?? 0)),
      });
    })().catch((error) => {
      this.updateRun(run, {
        ...run.state,
        status: 'stopping',
        detail: 'Could not confirm app cleanup. Retry Stop app. If the supervisor was lost, restart the task machine and retry.',
      });
      run.closing = undefined;
      throw error;
    });
    return run.closing;
  }

  async stopAll(taskId: number): Promise<void> {
    const running = [...this.runs.values()].filter(
      (run) => run.state.taskId === taskId && !run.cleaned,
    );
    const results = await Promise.allSettled(
      running.map((run) => this.stop(taskId, run.state.runId)),
    );
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('Could not stop all task apps');
    await this.journal?.drain(taskId);
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all(
      [...new Set([...this.runs.values()].map((run) => run.state.taskId))].map(
        (id) => this.stopAll(id),
      ),
    );
    if (!this.sharedVideoHost) await this.videoHost.destroy();
  }
}
