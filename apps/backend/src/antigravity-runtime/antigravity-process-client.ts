import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { createInterface } from 'readline';
import { buildAugmentedEnvAsync } from '../config/system-paths.js';
import { buildAntigravitySpawnCommand } from './antigravity-binary.js';
import type {
  AntigravityResultEvent,
  AntigravityStreamEvent,
} from './antigravity-runtime.types.js';

/** A turn can legitimately run for a long time; only give up after 30 minutes. */
const PROMPT_TIMEOUT_MS = 30 * 60_000;

export interface AntigravityProcessOptions {
  cwd: string;
  /** Extra env applied on top of the augmented shell env (e.g. API keys). */
  env?: Record<string, string>;
  /**
   * Extra CLI flags beyond `--input-format stream-json --output-format
   * stream-json`, chosen by the caller from the session's permission mode /
   * model / reasoning effort (e.g. `--dangerously-skip-permissions`,
   * `--model`, `--effort`).
   */
  extraArgs?: string[];
}

/**
 * Owns one `agy --input-format stream-json --output-format stream-json`
 * child process and speaks its newline-delimited JSON event stream.
 *
 * One process per Elevenex session rather than one shared server, mirroring
 * `GeminiSessionRuntime`: `agy`'s `cwd` is fixed at spawn (there is no
 * per-turn cwd parameter in the stream protocol), and Elevenex sessions live
 * in different worktrees.
 *
 * Unlike ACP or the Codex app-server, `agy`'s protocol is flat event
 * streaming with no JSON-RPC id/method envelope and no agent→client request
 * channel — a line in, a sequence of lines out, terminated by a `result`
 * event. There is therefore nothing to answer (no permission RPC, no
 * filesystem-serving capability) the way `GeminiSessionRuntime` has to.
 *
 * Emits:
 * - `step_event` — every parsed line from stdout, as `AntigravityStreamEvent`
 * - `exit`       — the child went away unexpectedly, `AntigravityProcessExit`
 */
export class AntigravityProcessClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private stderr = '';
  private stopped = false;
  private exited = false;
  private pendingTurn: {
    resolve: (result: AntigravityResultEvent) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  constructor(private readonly options: AntigravityProcessOptions) {
    super();
  }

  get isRunning(): boolean {
    return Boolean(this.child) && !this.exited;
  }

  getStderr(): string {
    return this.stderr;
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.stopped = false;
    this.exited = false;

    const env = await buildAugmentedEnvAsync(process.env, this.options.cwd);
    if (this.stopped) throw new Error('Antigravity process was stopped.');

    const { command, shell } = buildAntigravitySpawnCommand();
    const args = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      ...(this.options.extraArgs ?? []),
    ];
    const child = spawn(command, args, {
      cwd: this.options.cwd,
      env: { ...env, ...(this.options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell,
    });
    this.child = child;

    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => this.handleLine(line));

    child.stderr?.on('data', (chunk: Buffer) => {
      // Bounded: a long-lived session would otherwise accumulate this
      // forever.
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-16_000);
    });

    // A child that dies immediately still reports `stdin.writable === true`
    // for a tick, so an in-flight write lands on a broken pipe and fails
    // asynchronously. Swallow it here rather than letting it escalate to an
    // uncaughtException over an unusable optional CLI.
    child.stdin?.on('error', (error: Error) => this.handleExit(error));
    child.once('error', (error) => this.handleExit(error));
    child.once('exit', (code, signal) => {
      this.handleExit(
        new Error(
          `Antigravity process exited${code === null ? '' : ` with code ${code}`}${
            signal ? ` (${signal})` : ''
          }`,
        ),
      );
    });
  }

  /**
   * Writes one user turn to stdin and resolves once the matching `result`
   * event arrives. Callers must serialize calls (one turn in flight at a
   * time per process) — this class does not queue.
   */
  prompt(text: string): Promise<AntigravityResultEvent> {
    if (!this.child || this.exited) {
      return Promise.reject(new Error('Antigravity process is not running.'));
    }
    if (this.pendingTurn) {
      return Promise.reject(
        new Error('A turn is already in flight on this Antigravity process.'),
      );
    }

    return new Promise<AntigravityResultEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingTurn?.resolve !== resolve) return;
        this.pendingTurn = null;
        reject(
          new Error(`Antigravity turn timed out after ${PROMPT_TIMEOUT_MS}ms`),
        );
      }, PROMPT_TIMEOUT_MS);
      timer.unref?.();
      this.pendingTurn = { resolve, reject, timer };

      const line = `${JSON.stringify({
        event: 'user',
        message: { content: text },
      })}\n`;
      this.child!.stdin!.write(line, (error) => {
        if (!error) return;
        if (this.pendingTurn?.resolve !== resolve) return;
        clearTimeout(timer);
        this.pendingTurn = null;
        reject(error);
      });
    });
  }

  /**
   * Best-effort mid-turn interrupt. `agy`'s stream protocol documents no
   * cancel event (unlike ACP's `session/cancel`), so this sends SIGINT —
   * the common CLI convention for "stop the current turn, keep the process
   * alive" — and relies on the caller falling back to `stop()` (killing and
   * respawning) if the process doesn't recover. Unverified against a live
   * binary; correct this once observed.
   */
  interrupt(): void {
    if (!this.child || this.exited) return;
    try {
      this.child.kill('SIGINT');
    } catch {
      // ignore
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    if (this.pendingTurn) {
      clearTimeout(this.pendingTurn.timer);
      this.pendingTurn.reject(new Error('Antigravity process stopped.'));
      this.pendingTurn = null;
    }
    if (!child || child.exitCode !== null || child.killed) return;

    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => resolve()),
    );
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 1500);
    killTimer.unref?.();
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 2500).unref?.()),
    ]);
    clearTimeout(killTimer);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // `agy` may print startup noise to stdout before the stream settles;
      // dropping it is preferable to killing the session over it.
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

    const record = parsed as Record<string, unknown>;
    const kind = String(record['type'] ?? record['event'] ?? '');
    const event = { ...record, type: kind } as AntigravityStreamEvent;
    this.emit('step_event', event);

    if (kind === 'result' && this.pendingTurn) {
      const { resolve, timer } = this.pendingTurn;
      clearTimeout(timer);
      this.pendingTurn = null;
      resolve(event as AntigravityResultEvent);
    }
  }

  private handleExit(error: Error): void {
    if (this.exited) return;
    this.exited = true;
    const child = this.child;
    this.child = null;
    if (this.pendingTurn) {
      clearTimeout(this.pendingTurn.timer);
      this.pendingTurn.reject(error);
      this.pendingTurn = null;
    }
    if (!this.stopped) {
      this.emit('exit', {
        message: error.message,
        stderr: this.stderr,
        pid: child?.pid,
      });
    }
  }
}
