import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  BrowserCodeImage,
  BrowserHumanCommand,
  BrowserHumanRequest,
} from '@elevenex/shared';
import {
  object,
  type BrowserAgentDownload,
  type BrowserAgentHost,
  type BrowserAgentTarget,
} from './host.js';
import type {
  BrowserHostSnapshot,
  BrowserWorkerReply,
  PlaywrightCallback,
} from './playwright-channel.js';
import { PLAYWRIGHT_WORKER_SOURCE } from './playwright-worker-source.js';

interface TargetLease {
  readonly value: BrowserAgentTarget;
  readonly unsubscribe: () => void;
}

/** Main owns all leases, independently of Playwright's responsiveness. Killing
 * the worker cannot leave requests paused or restore an obsolete tab grant. */
export class PlaywrightWorkerClient {
  private worker?: Worker;
  private opening?: Promise<Worker>;
  private directory?: string;
  private stopped = false;
  private next = 0;
  private hostCalls = 0;
  private retainedResources = false;
  private readonly lifetime = new AbortController();
  private readonly targets = new Map<string, TargetLease>();
  private readonly downloads = new Map<
    string,
    { value: BrowserAgentDownload; target: BrowserAgentTarget }
  >();
  private readonly pending = new Map<
    number,
    { resolve(value: BrowserWorkerReply): void; reject(error: Error): void }
  >();
  private readonly requests = new Map<string, BrowserHumanRequest>();
  private readonly unwatch?: () => void;
  private callback?: PlaywrightCallback;
  private notify?: (handles: unknown[]) => void;
  private failed?: (message: string) => void;
  constructor(
    private readonly host: BrowserAgentHost,
    private readonly sessionId: number,
  ) {
    this.unwatch = host.watch?.(() => {
      for (const [key, lease] of this.targets) {
        try {
          lease.value.assert();
        } catch {
          this.release(key);
          this.worker?.postMessage({
            type: 'target-event',
            key,
            method: 'Elevenex.controlRevoked',
            params: {},
          });
        }
      }
      this.publish();
    });
  }
  bind(
    callback: PlaywrightCallback,
    notify: (handles: unknown[]) => void,
    failed?: (message: string) => void,
  ): void {
    this.callback = callback;
    this.notify = notify;
    this.failed = failed;
  }
  get retained(): boolean {
    return this.retainedResources;
  }
  drainRequests(): BrowserHumanRequest[] {
    const requests = [...this.requests.values()];
    this.requests.clear();
    return requests;
  }
  private snapshot(): BrowserHostSnapshot {
    const rows = this.host.list(this.sessionId);
    return {
      rows,
      documents: rows.map((row) => [row.id, this.host.document?.(row.id)]),
    };
  }
  private publish(): void {
    if (!this.stopped)
      this.worker?.postMessage({ type: 'snapshot', value: this.snapshot() });
  }
  private assertProfile(): void {
    if (
      this.host
        .list(this.sessionId)
        .some((row) => !row.owned && (row.populated ?? !!row.url))
    )
      throw new Error('Task profile authority unavailable');
  }
  private start(): Promise<Worker> {
    return (this.opening ??= (async () => {
      this.directory = await mkdtemp(join(tmpdir(), 'elevenex-playwright-'));
      if (this.stopped) {
        await rm(this.directory, { recursive: true, force: true });
        throw new Error('Browser worker closed');
      }
      const worker = new Worker(PLAYWRIGHT_WORKER_SOURCE, {
        eval: true,
        env: {},
        execArgv: [],
        workerData: {
          artifacts: this.directory,
          modules: {
            'playwright-core': require.resolve('playwright-core'),
            '@playwright/test': require.resolve('@playwright/test'),
          },
        },
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      });
      this.worker = worker;
      worker.on('message', (raw: unknown) => {
        if (!this.stopped) {
          try {
            this.message(object(raw));
          } catch {
            this.dispose('Malformed Playwright worker response');
          }
        }
      });
      worker.on('error', () =>
        this.dispose(
          'Playwright worker stopped; inspect browser state before retrying an action',
        ),
      );
      worker.on('exit', () =>
        this.dispose(
          'Playwright worker stopped; inspect browser state before retrying an action',
        ),
      );
      this.publish();
      return worker;
    })());
  }
  private message(raw: Record<string, unknown>): void {
    const id = Number(raw['id']);
    if (raw['type'] === 'host') {
      if (++this.hostCalls > 256) {
        this.dispose('Browser host operation capacity exceeded');
        return;
      }
      void this.hostCall(
        String(raw['method']),
        Array.isArray(raw['args']) ? raw['args'] : [],
      )
        .then(
          (value) => {
            this.publish();
            if (!this.stopped)
              this.worker?.postMessage({ type: 'host-reply', id, value });
          },
          (error: unknown) => {
            if (!this.stopped)
              this.worker?.postMessage({
                type: 'host-reply',
                id,
                error:
                  error instanceof Error
                    ? error.message
                    : 'Browser host operation failed',
              });
          },
        )
        .finally(() => this.hostCalls--);
    } else if (raw['type'] === 'reply') {
      this.retainedResources = raw['retained'] === true;
      for (const request of (raw['requests'] ?? []) as BrowserHumanRequest[])
        this.requests.set(request.id, request);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (typeof raw['error'] === 'string')
        pending.reject(new Error(raw['error']));
      else pending.resolve(raw as unknown as BrowserWorkerReply);
    } else if (raw['type'] === 'metadata')
      this.notify?.(raw['handles'] as unknown[]);
    else if (raw['type'] === 'failed') this.dispose(String(raw['error']));
    else if (raw['type'] === 'callback') {
      const operation =
        this.callback?.(
          Number(raw['functionId']),
          raw['args'] as unknown[],
          raw['handles'] as unknown[],
        ) ?? Promise.reject(new Error('Code callback unavailable'));
      void operation.then(
        (value) => {
          if (!this.stopped)
            this.worker?.postMessage({ type: 'callback-reply', id, value });
        },
        (error: unknown) => {
          if (!this.stopped)
            this.worker?.postMessage({
              type: 'callback-reply',
              id,
              error:
                error instanceof Error ? error.message : 'Code callback failed',
            });
        },
      );
    }
  }
  private release(key: string): void {
    const lease = this.targets.get(key);
    if (!lease) return;
    this.targets.delete(key);
    lease.unsubscribe();
    for (const [id, download] of this.downloads)
      if (download.target === lease.value) {
        this.downloads.delete(id);
        void download.value
          .cancel()
          .catch(() => undefined)
          .finally(() => download.value.dispose().catch(() => undefined));
      }
    void Promise.resolve(lease.value.dispose?.()).catch(() => undefined);
  }
  private lease(value: BrowserAgentTarget): unknown {
    if (this.stopped || this.targets.size >= 24) {
      void Promise.resolve(value.dispose?.()).catch(() => undefined);
      throw new Error('Browser target lease capacity exceeded');
    }
    try {
      value.assert();
    } catch (error) {
      void Promise.resolve(value.dispose?.()).catch(() => undefined);
      throw error;
    }
    const key = randomUUID();
    const unsubscribe = value.subscribe((method, params, sessionId) => {
      if (this.stopped || !this.targets.has(key)) return;
      try {
        value.assert();
      } catch {
        this.release(key);
        this.worker?.postMessage({
          type: 'target-event',
          key,
          method: 'Elevenex.controlRevoked',
          params: {},
        });
        return;
      }
      this.worker?.postMessage({
        type: 'target-event',
        key,
        method,
        params,
        sessionId,
      });
    });
    const stopDownloads = value.subscribeDownloads?.((download) => {
      if (this.stopped || !this.targets.has(key) || this.downloads.size >= 4) {
        void download.cancel().catch(() => undefined);
        return;
      }
      const id = randomUUID();
      this.downloads.set(id, { value: download, target: value });
      this.worker?.postMessage({
        type: 'download',
        key,
        download: id,
        url: download.url,
        filename: download.filename,
      });
    });
    this.targets.set(key, {
      value,
      unsubscribe: () => {
        unsubscribe();
        stopDownloads?.();
      },
    });
    return { key, id: value.id };
  }
  private async hostCall(method: string, args: unknown[]): Promise<unknown> {
    this.lifetime.signal.throwIfAborted();
    const signal = this.lifetime.signal;
    if (method === 'version') return this.host.version?.() ?? '140.0.0.0';
    if (method === 'proxy') {
      if (!this.host.proxy) throw new Error('Task proxy unavailable');
      return this.host.proxy();
    }
    if (method === 'authorizeUrl') {
      if (typeof args[0] !== 'string' || !this.host.authorizeUrl)
        throw new Error('URL authorization unavailable');
      return this.host.authorizeUrl(args[0], signal);
    }
    if (method === 'interact') {
      if (!this.host.interact) throw new Error('Human requests unavailable');
      const command = args[0] as BrowserHumanCommand;
      const request = await this.host.interact(this.sessionId, command);
      if (command.kind === 'request') this.requests.set(request.id, request);
      return request;
    }
    if (method === 'newPage') {
      if (!this.host.newPage) throw new Error('Page creation unavailable');
      return this.lease(await this.host.newPage(this.sessionId, signal));
    }
    if (method === 'get' || method === 'open') {
      if (typeof args[0] !== 'string')
        throw new Error('Invalid page identifier');
      return this.lease(
        await (method === 'get'
          ? this.host.get(this.sessionId, args[0])
          : this.host.open(this.sessionId, args[0], signal)),
      );
    }
    if (['cookies', 'addCookies', 'clearCookies'].includes(method)) {
      this.assertProfile();
      if (!this.host.profile)
        throw new Error('Task profile authority unavailable');
      const result =
        method === 'cookies'
          ? await this.host.profile.cookies()
          : method === 'addCookies'
            ? await this.host.profile.addCookies(
                args[0] as Parameters<
                  NonNullable<BrowserAgentHost['profile']>['addCookies']
                >[0],
              )
            : await this.host.profile.clearCookies();
      this.assertProfile();
      return result;
    }
    if (method.startsWith('download-')) {
      const key = String(args[0]),
        download = this.downloads.get(key);
      if (!download) throw new Error('Download expired');
      if (method === 'download-dispose') {
        this.downloads.delete(key);
        return download.value.dispose();
      }
      if (method === 'download-cancel') return download.value.cancel();
      download.target.assert();
      if (method === 'download-path') {
        const path = await download.value.path();
        download.target.assert();
        return path;
      }
    }
    if (method === 'target-dispose') {
      this.release(String(args[0]));
      return null;
    }
    const target = this.targets.get(String(args[0]))?.value;
    if (!target) throw new Error('Browser target lease expired');
    target.assert();
    let result: unknown;
    if (method === 'target-send') {
      if (
        typeof args[1] !== 'string' ||
        (args[3] !== undefined && typeof args[3] !== 'string')
      )
        throw new Error('Invalid protocol command');
      const profile = [
        'Network.getAllCookies',
        'Network.getCookies',
        'Network.setCookies',
        'Network.clearBrowserCookies',
      ].includes(args[1]);
      if (profile) this.assertProfile();
      result = await target.send(
        args[1],
        object(args[2]),
        args[3] as string | undefined,
      );
      if (profile) this.assertProfile();
    } else if (method === 'target-authorize') {
      if (typeof args[1] !== 'string') throw new Error('Invalid destination');
      await target.authorize?.(args[1], signal);
    } else if (method === 'target-playwright') await target.playwright?.();
    else if (method === 'target-goto') {
      if (typeof args[1] !== 'string') throw new Error('Invalid destination');
      await target.goto(args[1], signal);
    } else if (method === 'target-close') {
      await target.close();
      return null;
    } else if (method === 'target-interrupt') target.interrupt();
    else throw new Error('Unknown browser host operation');
    target.assert();
    return result;
  }
  private async call(
    op: 'prepare' | 'invoke' | 'inspect',
    value: unknown,
    signal: AbortSignal,
  ): Promise<BrowserWorkerReply> {
    signal.throwIfAborted();
    if (this.stopped) throw new Error('Playwright worker closed');
    const worker = await this.start();
    signal.throwIfAborted();
    if (this.stopped || this.pending.size >= 128)
      throw new Error('Playwright operation capacity exceeded');
    const id = ++this.next;
    const abort = () =>
      this.dispose(
        'Browser execution cancelled; inspect state before retrying an action',
      );
    signal.addEventListener('abort', abort, { once: true });
    try {
      return await new Promise<BrowserWorkerReply>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        worker.postMessage({ type: 'call', id, op, value });
      });
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  async prepare(signal: AbortSignal): Promise<unknown[]> {
    return (await this.call('prepare', undefined, signal)).value as unknown[];
  }
  async invoke(
    value: unknown,
    signal: AbortSignal,
    images: BrowserCodeImage[],
  ): Promise<unknown> {
    const result = await this.call('invoke', value, signal);
    if (
      images.length + result.images.length > 4 ||
      [...images, ...result.images].reduce(
        (size, image) => size + image.data.length,
        0,
      ) >
        8 * 1024 * 1024
    )
      throw new Error('Image budget exceeded');
    const offset = images.length;
    images.push(...result.images);
    if (
      result.images.length &&
      result.value &&
      typeof result.value === 'object'
    ) {
      const envelope = object(result.value),
        value = object(envelope['value']);
      if (typeof value['image'] === 'number')
        return {
          ...envelope,
          value: { ...value, image: value['image'] + offset },
        };
    }
    return result.value;
  }
  async inspect(input: unknown, signal: AbortSignal): Promise<unknown> {
    return (await this.call('inspect', input, signal)).value;
  }
  dispose(error?: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.lifetime.abort();
    this.unwatch?.();
    for (const key of this.targets.keys()) this.release(key);
    for (const download of this.downloads.values())
      void download.value
        .cancel()
        .catch(() => undefined)
        .finally(() => download.value.dispose().catch(() => undefined));
    this.downloads.clear();
    for (const pending of this.pending.values())
      pending.reject(new Error(error ?? 'Browser code scope closed'));
    this.pending.clear();
    const worker = this.worker;
    if (worker) {
      worker.postMessage({ type: 'dispose' });
      const timer = setTimeout(() => {
        void worker.terminate().finally(() => this.removeArtifacts());
      }, 250);
      timer.unref();
    } else void this.removeArtifacts();
    if (error) this.failed?.(error);
  }
  private async removeArtifacts(): Promise<void> {
    if (this.directory)
      await rm(this.directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      }).catch(() => undefined);
  }
}
