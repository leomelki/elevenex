import { Injectable, Logger } from '@nestjs/common';

/**
 * Exit code that means "start me again" rather than "the backend stopped".
 * Every launcher that supervises the backend — the embedded Electron child, the
 * remote/WSL `start-backend.sh`, the Windows `start-backend.ps1` — restarts the
 * process when it sees this code, and exits for good on anything else.
 */
export const BACKEND_RESTART_EXIT_CODE = 75;

/**
 * Only a supervised process can come back on its own. Self-respawning from here
 * would leave the launcher tracking a dead pid (and, on a remote host, a backend
 * running outside the tmux session the next connect tears down), so the restart
 * is refused instead when nothing is watching.
 */
const SUPERVISED_ENV_VAR = 'ELEVENEX_BACKEND_SUPERVISED';

/** Lets the HTTP response reach the client before the process goes away. */
const RESTART_DELAY_MS = 250;

/** Cap on graceful shutdown; a module that hangs must not block the restart. */
const SHUTDOWN_TIMEOUT_MS = 3000;

export interface BackendRuntimeStatus {
  /** Whether a launcher is watching this process and will start it again. */
  restartSupported: boolean;
  /** True once a restart has been accepted and the process is on its way out. */
  restarting: boolean;
  pid: number;
  startedAt: string;
}

interface ClosableApplication {
  close(): Promise<void>;
}

@Injectable()
export class RuntimeControlService {
  private readonly logger = new Logger(RuntimeControlService.name);
  private readonly startedAt = new Date().toISOString();
  private application: ClosableApplication | null = null;
  private restarting = false;

  /**
   * Handed the Nest application from `bootstrap()` so a restart can run the
   * module shutdown hooks (PTY tails, watchers, sockets) before exiting instead
   * of orphaning everything the backend spawned.
   */
  bindApplication(application: ClosableApplication): void {
    this.application = application;
  }

  isRestartSupported(): boolean {
    return process.env[SUPERVISED_ENV_VAR] === '1';
  }

  getStatus(): BackendRuntimeStatus {
    return {
      restartSupported: this.isRestartSupported(),
      restarting: this.restarting,
      pid: process.pid,
      startedAt: this.startedAt,
    };
  }

  /** Idempotent: repeated calls while the exit is pending are no-ops. */
  requestRestart(): BackendRuntimeStatus {
    if (this.restarting || !this.isRestartSupported()) {
      return this.getStatus();
    }

    this.restarting = true;
    this.logger.log(
      'Restart requested — the backend will exit and be relaunched',
    );
    setTimeout(() => {
      void this.shutdownAndExit();
    }, RESTART_DELAY_MS);

    return this.getStatus();
  }

  private async shutdownAndExit(): Promise<void> {
    try {
      await this.closeApplicationWithTimeout();
    } catch (error) {
      this.logger.warn(
        `Graceful shutdown failed before restart: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    process.exit(BACKEND_RESTART_EXIT_CODE);
  }

  private async closeApplicationWithTimeout(): Promise<void> {
    const application = this.application;
    if (!application) {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        application.close(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.logger.warn(
              `Shutdown hooks did not finish within ${SHUTDOWN_TIMEOUT_MS}ms — exiting anyway`,
            );
            resolve();
          }, SHUTDOWN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
