import { parentPort, workerData } from 'node:worker_threads';
import { PlaywrightBroker } from './playwright-broker.js';
import { WorkerBrowserHost } from './playwright-worker-host.js';
import { object } from './host.js';
import {
  pickBrowserElement,
  validatePickedBrowserElement,
} from './element-picker-implementation.js';
import type { BrowserCodeImage } from '@elevenex/shared';

const port = parentPort!;
const host = new WorkerBrowserHost();
const broker = new PlaywrightBroker(host, 1, String(workerData.artifacts));
const lifetime = new AbortController();
// V8 heap limits do not include Buffer/ArrayBuffer storage. Watch that separate
// allocation budget too; deadlines still let main terminate a stuck worker.
const memoryBudget = setInterval(() => {
  if (process.memoryUsage().external > 64 * 1024 * 1024)
    port.postMessage({
      type: 'failed',
      error: 'Playwright binary-memory budget exceeded; request smaller data',
    });
}, 100);
memoryBudget.unref();
let nextCallback = 0;
const callbacks = new Map<
  number,
  { resolve(value: unknown): void; reject(error: Error): void }
>();
broker.bind(
  (functionId, args, handles) =>
    new Promise((resolve, reject) => {
      const id = ++nextCallback;
      callbacks.set(id, { resolve, reject });
      port.postMessage({ type: 'callback', id, functionId, args, handles });
    }),
  (handles) => port.postMessage({ type: 'metadata', handles }),
  (error) => port.postMessage({ type: 'failed', error }),
);
port.on('message', (value: unknown) => {
  const raw = object(value);
  if (raw['type'] === 'dispose') {
    clearInterval(memoryBudget);
    lifetime.abort();
    broker.dispose();
    return;
  }
  if (raw['type'] === 'callback-reply') {
    const callback = callbacks.get(Number(raw['id']));
    if (!callback) return;
    callbacks.delete(Number(raw['id']));
    if (typeof raw['error'] === 'string')
      callback.reject(new Error(raw['error']));
    else callback.resolve(raw['value']);
    return;
  }
  if (raw['type'] !== 'call') {
    host.receive(raw);
    return;
  }
  const images: BrowserCodeImage[] = [];
  const execute = async (): Promise<unknown> => {
    if (raw['op'] === 'prepare') return broker.prepare(lifetime.signal);
    // This outer opcode is sent only by the main-owned human controller. The
    // agent's JSON invocation is nested under 'invoke' and cannot select it.
    if (raw['op'] === 'inspect') {
      const input = object(raw['value']),
        id = String(input['tabId']);
      const target = await host.get(1, id);
      if (input['selection'])
        return validatePickedBrowserElement(
          target,
          input['selection'] as import('@elevenex/shared').BrowserHumanElement,
          () => host.list().some((row) => row.id === id && row.owned),
          String(input['version'] ?? '140.0.0.0'),
        );
      return pickBrowserElement(
        target,
        Number(input['x']),
        Number(input['y']),
        String(input['documentId']),
        () => host.list().some((row) => row.id === id && row.owned),
        String(input['version'] ?? '140.0.0.0'),
        input['capture'] !== false,
        input['fingerprint'],
      );
    }
    if (raw['op'] !== 'invoke')
      throw new Error('Unknown browser worker operation');
    return broker.invoke(raw['value'], lifetime.signal, images);
  };
  void execute().then(
    (value) =>
      port.postMessage({
        type: 'reply',
        id: raw['id'],
        value,
        images,
        retained: broker.retained,
        requests: broker.drainRequests(),
      }),
    (error: unknown) =>
      port.postMessage({
        type: 'reply',
        id: raw['id'],
        error:
          error instanceof Error
            ? error.message
            : 'Playwright operation failed',
        retained: broker.retained,
        requests: broker.drainRequests(),
      }),
  );
});
