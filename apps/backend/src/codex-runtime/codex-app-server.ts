import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ChildProcess, spawn } from 'child_process';
import { createInterface } from 'readline';
import { buildAugmentedEnv, findBinary } from '../config/system-paths.js';

const CLIENT_INFO = {
  name: 'elevenex',
  title: 'Elevenex',
  version: '1.0.0',
};

// How long the app-server stays alive after the last reference is released.
// Long enough to absorb workspace tab switches without re-spawning, short
// enough that an idle backend doesn't keep the process forever.
const IDLE_SHUTDOWN_MS = 60_000;

const INITIALIZE_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  method: string;
  timer: NodeJS.Timeout;
}

export interface CodexAppServerNotification {
  method: string;
  params: unknown;
}

export type AppServerNotificationListener = (
  notification: CodexAppServerNotification,
) => void;

/**
 * Manages a single long-lived `codex app-server` process that serves all
 * codex turns for this backend. The process is spawned lazily on first use,
 * kept alive while any caller holds a reference, and torn down after an
 * idle delay once everyone releases. Crashes trigger a fresh respawn on the
 * next request.
 *
 * Protocol: newline-delimited JSON-RPC 2.0 (`{"jsonrpc": "2.0"}` header
 * omitted on the wire per the codex spec) over the child's stdin/stdout.
 * See `codex-rs/app-server/README.md` for the full method catalog.
 */
@Injectable()
export class CodexAppServerClient implements OnModuleDestroy {
  private readonly logger = new Logger('CodexAppServer');
  private child: ChildProcess | null = null;
  private initializePromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<AppServerNotificationListener>();
  private refCount = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  onModuleDestroy(): void {
    this.shuttingDown = true;
    this.clearIdleTimer();
    if (this.child) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  }

  addRef(): void {
    this.refCount += 1;
    this.clearIdleTimer();
  }

  release(): void {
    if (this.refCount === 0) return;
    this.refCount -= 1;
    if (this.refCount === 0) {
      this.scheduleIdleShutdown();
    }
  }

  /**
   * Registers a global notification listener. The caller is responsible for
   * filtering by method/threadId. Returns an unsubscribe function.
   */
  onNotification(listener: AppServerNotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  async ensureReady(): Promise<void> {
    if (this.child && !this.child.killed && this.initializePromise) {
      await this.initializePromise;
      return;
    }
    this.spawnServer();
    if (!this.initializePromise) {
      throw new Error('codex app-server failed to start');
    }
    await this.initializePromise;
  }

  async request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    await this.ensureReady();
    return this.sendRequest<T>(method, params, timeoutMs);
  }

  notify(method: string, params: unknown): void {
    if (!this.child || !this.child.stdin || this.child.killed) {
      throw new Error('codex app-server is not running');
    }
    const payload = JSON.stringify({ method, params }) + '\n';
    this.child.stdin.write(payload);
  }

  private sendRequest<T>(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<T> {
    if (!this.child || !this.child.stdin || this.child.killed) {
      return Promise.reject(new Error('codex app-server is not running'));
    }
    const id = this.nextRequestId++;
    const payload = JSON.stringify({ method, id, params }) + '\n';

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(
          new Error(
            `codex app-server request "${method}" timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        method,
        timer,
      });
      this.child!.stdin!.write(payload);
    });
  }

  private spawnServer(): void {
    if (this.shuttingDown) {
      throw new Error('codex app-server client is shutting down');
    }
    const codexBin = findBinary('codex') ?? 'codex';
    this.logger.log(`Spawning codex app-server (${codexBin})`);
    const child = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
      env: buildAugmentedEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => this.handleLine(line));

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (text) this.logger.debug(`stderr: ${text}`);
    });

    child.once('error', (error) => {
      this.logger.error(`codex app-server spawn error: ${String(error)}`);
      this.tearDown(error);
    });

    child.once('exit', (code, signal) => {
      this.logger.log(`codex app-server exited (code=${code} signal=${signal})`);
      this.tearDown(
        new Error(
          `codex app-server exited unexpectedly (code=${code ?? 'null'} signal=${
            signal ?? 'null'
          })`,
        ),
      );
    });

    // Send the initialize handshake. Failure here propagates to ensureReady().
    this.initializePromise = this.sendRequest<unknown>(
      'initialize',
      {
        clientInfo: CLIENT_INFO,
        capabilities: {
          experimentalApi: true,
        },
      },
      INITIALIZE_TIMEOUT_MS,
    )
      .then(() => {
        // Required follow-up per protocol: notify "initialized".
        this.notify('initialized', {});
      })
      .catch((error) => {
        // Re-throw so callers waiting on ensureReady see the failure, but
        // also tear the child down so the next caller spawns fresh.
        this.tearDown(error instanceof Error ? error : new Error(String(error)));
        throw error;
      });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: any;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      this.logger.warn(`Failed to parse app-server message: ${trimmed}`);
      return;
    }

    if (typeof message?.id === 'number') {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) {
          const errMessage =
            (message.error?.message as string | undefined) ?? 'Unknown error';
          pending.reject(new Error(errMessage));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    if (typeof message?.method === 'string') {
      const notification: CodexAppServerNotification = {
        method: message.method,
        params: message.params,
      };
      for (const listener of this.notificationListeners) {
        try {
          listener(notification);
        } catch (error) {
          this.logger.warn(
            `app-server notification listener threw: ${String(error)}`,
          );
        }
      }
    }
  }

  private tearDown(error: Error): void {
    const child = this.child;
    this.child = null;
    this.initializePromise = null;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error(
          `codex app-server terminated before "${pending.method}" completed: ${error.message}`,
        ),
      );
    }
    this.pending.clear();
    if (child && !child.killed) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  }

  private scheduleIdleShutdown(): void {
    if (this.shuttingDown || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.refCount > 0) return;
      this.logger.log('Shutting down idle codex app-server');
      const child = this.child;
      this.child = null;
      this.initializePromise = null;
      if (child && !child.killed) {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    }, IDLE_SHUTDOWN_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
