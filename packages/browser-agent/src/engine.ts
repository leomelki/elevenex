import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type {
  BrowserCodeCommand,
  BrowserCodeImage,
  BrowserCodeResult,
} from '@elevenex/shared';
import { BrowserAgentBroker } from './broker.js';
import { object, type BrowserAgentHost } from './host.js';
import { PLAYWRIGHT_FACADE } from './playwright-facade.js';
import { REALM_DATA } from './realm-data.js';
import { BOOTSTRAP, WORKER_SOURCE } from './worker-source.js';

class Sandbox {
  readonly id = randomUUID();
  private readonly worker = new Worker(WORKER_SOURCE, {
    eval: true,
    env: {},
    execArgv: [],
    workerData: {
      bootstrap: BOOTSTRAP,
      facade: PLAYWRIGHT_FACADE,
      realmData: REALM_DATA,
    },
    resourceLimits: {
      maxOldGenerationSizeMb: 64,
      maxYoungGenerationSizeMb: 16,
      stackSizeMb: 4,
    },
  });
  private active?: { fail(message: string): void };
  private stopped = false;
  private idle?: ReturnType<typeof setTimeout>;
  private readonly broker: BrowserAgentBroker;
  private readonly lifetime = new AbortController();
  private nextCallback = 0;
  private nextExecution = 0;
  private readonly callbackQueue: (() => void)[] = [];
  private callbacksRunning = 0;
  private pumpCallbacks(): void {
    while (
      !this.stopped &&
      this.callbacksRunning < 8 &&
      this.callbackQueue.length
    )
      this.callbackQueue.shift()!();
  }
  private readonly callbacks = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer?: ReturnType<typeof setTimeout>;
      started: boolean;
    }
  >();
  private readonly backgroundImages: BrowserCodeImage[] = [];
  private readonly backgroundLogs: string[] = [];
  constructor(
    host: BrowserAgentHost,
    sessionId: number,
    private readonly retire: () => void,
  ) {
    this.broker = new BrowserAgentBroker(host, sessionId);
    this.broker.bind(
      (functionId, args, handles) => {
        if (this.stopped || this.callbacks.size >= 128)
          return Promise.reject(new Error('Code callback capacity exceeded'));
        if (Buffer.byteLength(JSON.stringify({ args, handles })) > 1048576)
          return Promise.reject(
            new Error('Callback data exceeded 1 MiB; inspect smaller values'),
          );
        return new Promise((resolve, reject) => {
          const id = ++this.nextCallback;
          const pending: {
            resolve(value: unknown): void;
            reject(error: Error): void;
            timer?: ReturnType<typeof setTimeout>;
            started: boolean;
          } = { resolve, reject, started: false };
          this.callbacks.set(id, pending);
          this.callbackQueue.push(() => {
            if (this.stopped || !this.callbacks.has(id)) return;
            pending.started = true;
            this.callbacksRunning++;
            pending.timer = setTimeout(() => {
              this.callbacks.delete(id);
              this.callbacksRunning--;
              reject(new Error('Code callback timed out'));
              if (this.active) this.active.fail('A browser callback timed out');
              else this.dispose();
              this.pumpCallbacks();
            }, 10000);
            this.worker.postMessage({
              type: 'callback',
              id,
              functionId,
              args,
              handles,
            });
          });
          this.pumpCallbacks();
        });
      },
      (handles) => {
        if (!this.stopped) {
          if (Buffer.byteLength(JSON.stringify(handles)) > 1048576) {
            if (this.active)
              this.active.fail('Playwright metadata exceeded its budget');
            else this.dispose();
          } else this.worker.postMessage({ type: 'init', handles });
        }
      },
      (message) => {
        if (this.active) this.active.fail(message);
        else this.dispose();
      },
    );
    this.worker.on('message', (raw: unknown) => {
      if (this.stopped) return;
      try {
        const data = object(raw);
        if (Array.isArray(data['callbacks']))
          for (const item of data['callbacks']) {
            const result = object(item),
              pending = this.callbacks.get(Number(result['id']));
            if (!pending) continue;
            clearTimeout(pending.timer);
            this.callbacks.delete(Number(result['id']));
            if (pending.started) this.callbacksRunning--;
            this.pumpCallbacks();
            if (typeof result['error'] === 'string')
              pending.reject(new Error(result['error']));
            else pending.resolve(result['value']);
          }
        if (this.active) return;
        if (data['fatal']) {
          this.dispose();
          return;
        }
        if (Array.isArray(data['logs']))
          for (const log of data['logs'])
            if (
              typeof log === 'string' &&
              this.backgroundLogs.length < 100 &&
              this.backgroundLogs.join('').length + log.length < 32000
            )
              this.backgroundLogs.push(log);
        if (Array.isArray(data['queue']))
          for (const item of data['queue']) {
            const rpc = object(item);
            if (
              typeof rpc['method'] !== 'string' ||
              !Array.isArray(rpc['args'])
            ) {
              this.dispose();
              return;
            }
            void this.broker
              .invoke(
                rpc['method'],
                rpc['args'],
                this.lifetime.signal,
                this.backgroundImages,
              )
              .then(
                (value) => {
                  if (!this.stopped)
                    this.worker.postMessage({
                      type: 'reply',
                      id: rpc['id'],
                      value,
                    });
                },
                (error: unknown) => {
                  if (!this.stopped)
                    this.worker.postMessage({
                      type: 'reply',
                      id: rpc['id'],
                      error:
                        error instanceof Error
                          ? error.message
                          : 'Background operation failed',
                    });
                },
              );
          }
      } catch {
        if (this.active) this.active.fail('Malformed browser worker response');
        else this.dispose();
      }
    });
    this.worker.on('error', (error: unknown) => {
      this.active?.fail(
        error instanceof Error ? error.message : 'Browser worker failed',
      );
      this.dispose();
    });
    this.worker.on('exit', () => {
      this.active?.fail('Browser code worker stopped');
      this.dispose();
    });
  }
  get busy(): boolean {
    return !!this.active;
  }
  run(
    command: BrowserCodeCommand,
    signal: AbortSignal,
  ): Promise<BrowserCodeResult> {
    if (this.active)
      return Promise.reject(
        new Error(
          'Browser code already running for this session; await it before another call',
        ),
      );
    if (this.stopped)
      return Promise.reject(
        new Error('Sandbox stopped; call browser_run again'),
      );
    clearTimeout(this.idle);
    const runId = ++this.nextExecution;
    const controller = new AbortController(),
      images: BrowserCodeImage[] = this.backgroundImages.splice(0),
      logs: string[] = this.backgroundLogs.splice(0);
    let operations = 0,
      inFlight = 0,
      output = 0;
    return new Promise((resolve) => {
      const finish = (
        value: unknown,
        error?: BrowserCodeResult['error'],
        reset = false,
      ) => {
        if (this.active !== active) return;
        this.active = undefined;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.worker.removeListener('message', message);
        controller.abort();
        if (reset) {
          this.broker.interrupt();
          this.dispose();
        } else {
          if (!this.broker.retained) {
            this.idle = setTimeout(() => this.dispose(), 300000);
            this.idle.unref();
          }
        }
        const requests = this.broker.drainRequests();
        resolve({
          sandboxId: this.id,
          value,
          logs,
          images,
          ...(requests.length ? { requests } : {}),
          ...(error ? { error } : {}),
        });
      };
      const fail = (message: string) =>
        finish(null, { message, outcomeUnknown: true }, true);
      const active = { fail };
      const abort = () =>
        fail(
          'Browser execution cancelled. Accepted actions may have completed; inspect before retrying. Sandbox reset; tabs remain open.',
        );
      const timer = setTimeout(
        () =>
          fail(
            'Browser execution timed out. Accepted actions may have completed; inspect before retrying. Sandbox reset; tabs remain open.',
          ),
        command.timeoutMs,
      );
      const message = (raw: unknown) => {
        if (this.active !== active) return;
        try {
          const data = object(raw);
          if (data['fatal']) {
            fail(String(data['fatal']).slice(0, 2048));
            return;
          }
          if (!Array.isArray(data['queue']) || !Array.isArray(data['logs']))
            throw new Error('Invalid browser worker reply');
          for (const log of data['logs']) {
            if (typeof log !== 'string')
              throw new Error('Invalid console output');
            output += log.length;
            if (output > 32000 || logs.length >= 100)
              throw new Error('Console output limit reached');
            logs.push(log);
          }
          for (const rawRpc of data['queue']) {
            const rpc = object(rawRpc);
            if (
              typeof rpc['id'] !== 'number' ||
              typeof rpc['method'] !== 'string' ||
              !Array.isArray(rpc['args']) ||
              ++operations > 512 ||
              ++inFlight > 64
            )
              throw new Error(
                'Browser operation budget exceeded (512 per call, 64 concurrent)',
              );
            void this.broker
              .invoke(rpc['method'], rpc['args'], controller.signal, images)
              .then(
                (value) => reply(rpc['id'], value),
                (error: unknown) =>
                  reply(
                    rpc['id'],
                    null,
                    error instanceof Error ? error.message : String(error),
                  ),
              );
          }
          if (
            data['done'] &&
            object(data['done'])['runId'] === runId &&
            data['pending'] === 0 &&
            data['queue'].length === 0 &&
            inFlight === 0
          ) {
            const done = object(data['done']);
            finish(
              done['value'],
              done['error']
                ? {
                    message: String(done['error']).slice(0, 4096),
                    outcomeUnknown: false,
                  }
                : undefined,
            );
          }
        } catch (error) {
          fail(
            error instanceof Error ? error.message : 'Browser execution failed',
          );
        }
      };
      const reply = (id: unknown, value: unknown, error?: string) => {
        inFlight--;
        if (this.active !== active || controller.signal.aborted) return;
        try {
          if (Buffer.byteLength(JSON.stringify(value ?? null)) > 1048576) {
            value = null;
            error =
              'Browser reply exceeded 1 MiB; filter in evaluate or use smaller windows';
          }
          this.worker.postMessage({
            type: 'reply',
            id,
            value,
            error: error?.slice(0, 4096),
          });
        } catch {
          fail('Browser reply is not serializable');
        }
      };
      this.active = active;
      signal.addEventListener('abort', abort, { once: true });
      this.worker.on('message', message);
      if (signal.aborted) abort();
      else
        void this.broker.prepare(controller.signal).then(
          (handles) => {
            if (this.active !== active || controller.signal.aborted) return;
            this.worker.postMessage({ type: 'init', handles });
            this.worker.postMessage({ type: 'run', runId, code: command.code });
          },
          (error: unknown) =>
            fail(
              error instanceof Error
                ? error.message
                : 'Browser initialization failed',
            ),
        );
    });
  }
  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.lifetime.abort();
    for (const callback of this.callbacks.values()) {
      clearTimeout(callback.timer);
      callback.reject(new Error('Browser code scope closed'));
    }
    this.callbacks.clear();
    this.callbackQueue.length = 0;
    this.callbacksRunning = 0;
    this.active?.fail(
      'Browser sandbox reset. Inspect tabs before repeating an interrupted action.',
    );
    clearTimeout(this.idle);
    this.broker.interrupt();
    this.broker.dispose();
    void this.worker.terminate();
    this.retire();
  }
}

/** Task-owned execution: isolated conversation state, bounded warm workers, no mutation replay. */
export class BrowserAgentEngine {
  private readonly sessions = new Map<number, Sandbox>();
  private stopped = false;
  constructor(private readonly host: BrowserAgentHost) {}
  get active(): boolean {
    return [...this.sessions.values()].some((sandbox) => sandbox.busy);
  }
  async execute(
    sessionId: number,
    command: BrowserCodeCommand,
    signal: AbortSignal,
  ): Promise<BrowserCodeResult> {
    signal.throwIfAborted();
    if (command.api === 2 && !this.host.playwright)
      throw new Error('Browser host requires a Playwright update');
    if (this.stopped) throw new Error('Browser task closed');
    if (
      !Number.isSafeInteger(sessionId) ||
      sessionId < 1 ||
      typeof command.code !== 'string' ||
      command.code.length > 65536 ||
      !Number.isInteger(command.timeoutMs) ||
      command.timeoutMs < 250 ||
      command.timeoutMs > 60000
    )
      throw new Error('Invalid browser code request');
    let sandbox = this.sessions.get(sessionId);
    if (command.reset) {
      sandbox?.dispose();
      return {
        sandboxId: '',
        value: { reset: true, tabsPreserved: true },
        logs: [],
        images: [],
      };
    }
    if (!sandbox) {
      if (this.sessions.size >= 8)
        throw new Error(
          'Eight browser sandboxes are already active; reset an idle session',
        );
      sandbox = new Sandbox(this.host, sessionId, () => {
        if (this.sessions.get(sessionId) === sandbox)
          this.sessions.delete(sessionId);
      });
      this.sessions.set(sessionId, sandbox);
    }
    return sandbox.run(command, signal);
  }
  dispose(): void {
    this.stopped = true;
    for (const sandbox of this.sessions.values()) sandbox.dispose();
    this.sessions.clear();
  }
}
