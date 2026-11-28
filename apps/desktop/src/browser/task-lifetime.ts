import type { BackendClient } from '../backend-client/client';
import { requestBackendJson } from '../backend-client/transport';
import { record } from './validation';

const CHECK_INTERVAL_MS = 2000;
const VERIFICATION_GRACE_MS = 30000;

/** Cached and detached tabs need a task lifetime even when the workspace UI is absent. */
export function watchTaskBrowser(
  client: BackendClient,
  windowId: number,
  scopeId: string,
  taskId: number,
  retire: () => void,
): () => void {
  const lifetime = new AbortController();
  let lastVerified = performance.now();
  let timer = setTimeout(() => void check(), CHECK_INTERVAL_MS);
  const stop = () => {
    lifetime.abort();
    clearTimeout(timer);
  };
  async function check(): Promise<void> {
    const reply = await client.execute(windowId, scopeId, 'task-browser-lifetime:' + taskId, false, async (endpoint, signal) => {
      const state = record(await requestBackendJson(endpoint, {
        path: '/api/desktop-browser/tasks/' + taskId + '?lifecycle=1',
        limit: 4096,
      }, signal));
      if (state['id'] !== taskId || state['state'] !== 'ready') throw new Error('Invalid browser task status');
    }, CHECK_INTERVAL_MS, lifetime.signal);
    if (lifetime.signal.aborted) return;
    const now = performance.now();
    if (reply.ok) lastVerified = now;
    else if ((reply.error.code === 'http' && (reply.error.status === 400 || reply.error.status === 404)) ||
      now - lastVerified >= VERIFICATION_GRACE_MS) {
      stop();
      retire();
      return;
    }
    timer = setTimeout(() => void check(), CHECK_INTERVAL_MS);
  }
  return stop;
}
