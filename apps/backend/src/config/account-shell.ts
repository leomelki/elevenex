import { userInfo } from 'node:os';
import { Worker } from 'node:worker_threads';

interface AccountWorker {
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  removeAllListeners(): unknown;
  terminate(): Promise<number>;
  unref?(): unknown;
}

const LOOKUP_SOURCE = `const {parentPort}=require('node:worker_threads');
try { parentPort.postMessage(require('node:os').userInfo().shell); }
catch { parentPort.postMessage(null); }`;

/** NSS/LDAP account reads run once off the event loop; the application owns cleanup. */
export class AccountShellLookup {
  private value?: { platform: string; shell: string };
  private pending?: Promise<string>;
  private stop?: () => void;

  constructor(
    private readonly timeoutMs: number,
    private readonly createWorker: () => AccountWorker = () =>
      new Worker(LOOKUP_SOURCE, { eval: true }),
  ) {}

  get cached(): string | undefined {
    return this.value?.platform === process.platform
      ? this.value.shell
      : undefined;
  }

  /** Compatibility for synchronous terminal APIs called before application warm-up. */
  sync(): string {
    if (this.cached) return this.cached;
    try {
      return this.remember(userInfo().shell);
    } catch {
      return this.remember(null);
    }
  }

  read(): Promise<string> {
    const cached = this.cached;
    if (cached) return Promise.resolve(cached);
    if (this.pending) return this.pending;
    this.pending = new Promise((resolve) => {
      let worker: AccountWorker | undefined;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (shell: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.stop = undefined;
        worker?.removeAllListeners();
        worker?.unref?.();
        void worker?.terminate().catch(() => undefined);
        resolve(this.remember(typeof shell === 'string' ? shell : null));
      };
      this.stop = () => finish(null);
      try {
        worker = this.createWorker();
        worker.once('message', finish);
        worker.once('error', () => finish(null));
        worker.once('exit', () => finish(null));
        timer = setTimeout(() => finish(null), this.timeoutMs);
        timer.unref();
      } catch {
        finish(null);
      }
    });
    return this.pending;
  }

  dispose(): void {
    this.stop?.();
  }

  private remember(shell: string | null): string {
    const selected =
      shell || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
    this.value = { platform: process.platform, shell: selected };
    return selected;
  }
}
