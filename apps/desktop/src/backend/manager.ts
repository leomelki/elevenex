import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BackendStatus } from '@elevenex/shared';
import { installBackend } from './install';
import { startBackend, type RunningBackend } from './process';
import type { BackendRelease } from './release';

export interface BackendManagerOptions {
  readonly root: string;
  readonly release: () => Promise<BackendRelease>;
  readonly install?: typeof installBackend;
  readonly start?: typeof startBackend;
}

/** Application-scoped owner, shared by windows and disposed before Electron quits. */
export class BackendManager {
  private status: BackendStatus = { phase: 'idle', version: null };
  private readonly listeners = new Set<(status: BackendStatus) => void>();
  private readonly lifetime = new AbortController();
  private operation: Promise<BackendStatus> | undefined;
  private running: RunningBackend | undefined;
  private shutdown: Promise<void> | undefined;
  private readonly crashes: number[] = [];

  constructor(private readonly options: BackendManagerOptions) {}

  snapshot(): BackendStatus { return { ...this.status }; }

  subscribe(listener: (status: BackendStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): Promise<BackendStatus> {
    if (this.operation) return this.operation;
    if (this.lifetime.signal.aborted || this.running) return Promise.resolve(this.snapshot());
    this.crashes.length = 0;
    return this.run(() => this.launch());
  }

  restart(): Promise<BackendStatus> {
    if (this.operation) return this.operation;
    if (this.lifetime.signal.aborted) return Promise.resolve(this.snapshot());
    this.crashes.length = 0;
    return this.run(async () => {
      await this.stopRunning();
      await this.launch();
    });
  }

  dispose(): Promise<void> {
    this.shutdown ??= (async () => {
      this.lifetime.abort();
      this.publish({ phase: 'stopping', version: this.status.version });
      await this.operation;
      await this.stopRunning();
      this.publish({ phase: 'stopped', version: this.status.version });
      this.listeners.clear();
    })();
    return this.shutdown;
  }

  private publish(status: BackendStatus): void {
    this.status = Object.freeze(status);
    for (const listener of this.listeners) {
      try { listener(this.snapshot()); }
      catch (error) { console.error('Backend status listener failed:', error); }
    }
  }

  private run(work: () => Promise<void>): Promise<BackendStatus> {
    const operation = Promise.resolve().then(work).catch((error: unknown) => {
      if (!this.lifetime.signal.aborted) {
        this.publish({ phase: 'failed', version: this.status.version, message: error instanceof Error ? error.message.slice(0, 12_288) : 'Local backend failed' });
      }
    }).then(() => this.snapshot());
    this.operation = operation;
    void operation.finally(() => { if (this.operation === operation) this.operation = undefined; });
    return operation;
  }

  private async stopRunning(): Promise<void> {
    const running = this.running;
    this.running = undefined;
    if (running) {
      this.publish({ phase: 'stopping', version: this.status.version });
      await running.stop();
    }
  }

  private async launch(): Promise<void> {
    const signal = this.lifetime.signal;
    signal.throwIfAborted();
    this.publish({ phase: 'checking', version: this.status.version });
    const release = await this.options.release();
    signal.throwIfAborted();
    this.publish({ phase: 'checking', version: release.version });
    await mkdir(join(this.options.root, 'data'), { recursive: true, mode: 0o700 });
    const installation = await (this.options.install ?? installBackend)(this.options.root, release, signal, (phase, progress) => {
      if (phase === 'downloading') this.publish({ phase, version: release.version, receivedBytes: progress?.receivedBytes ?? 0, totalBytes: progress?.totalBytes ?? null });
      else this.publish({ phase, version: release.version });
    });
    signal.throwIfAborted();
    this.publish({ phase: 'starting', version: release.version });
    const running = await (this.options.start ?? startBackend)(installation, this.options.root, release.version, signal);
    if (signal.aborted) { await running.stop(); signal.throwIfAborted(); }
    this.running = running;
    this.publish({ phase: 'ready', version: release.version, url: running.url });
    void running.exited.then(async result => {
      if (this.running !== running || signal.aborted) return;
      this.running = undefined;
      // This continuation runs outside the original startup operation.
      await this.operation;
      if (signal.aborted) return;
      const now = Date.now();
      while (this.crashes[0] !== undefined && this.crashes[0] < now - 60_000) this.crashes.shift();
      if (this.crashes.length >= 3) {
        this.publish({ phase: 'failed', version: release.version, message: 'Local backend stopped repeatedly. Retry to start it again.' });
        return;
      }
      this.crashes.push(now);
      await this.run(async () => {
        this.publish({ phase: 'starting', version: release.version });
        await delay(result.code === 75 ? 0 : 500 * this.crashes.length, undefined, { signal });
        await this.launch();
      });
    });
  }
}
