import type { BrowserHumanRequest } from '@elevenex/shared';

interface RecordEntry {
  readonly taskId: number;
  readonly sessionId: number;
  readonly hostId: string;
  value: BrowserHumanRequest;
}
interface Waiter {
  resolve(value: BrowserHumanRequest): void;
  reject(error: Error): void;
  cleanup(): void;
}

/** Backend attention state, pinned to the authenticated creator and actual
 * browser host. Viewer updates cannot introduce a request or change its owner. */
export class BrowserHumanMailbox {
  private readonly records = new Map<string, RecordEntry>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  register(
    taskId: number,
    sessionId: number,
    hostId: string,
    requests: readonly BrowserHumanRequest[],
  ): void {
    this.sweep();
    for (const request of requests) {
      if (request.sessionId !== sessionId || request.status !== 'pending')
        throw new Error('Invalid browser request creator');
      const previous = this.records.get(request.id);
      if (previous) {
        if (
          previous.taskId !== taskId ||
          previous.sessionId !== sessionId ||
          previous.hostId !== hostId
        )
          throw new Error('Browser request identity collision');
        continue;
      }
      if (this.records.size >= 512) {
        const old = [...this.records].find(
          ([, entry]) => entry.value.status !== 'pending',
        );
        if (!old) throw new Error('Browser request capacity reached');
        this.records.delete(old[0]);
      }
      this.records.set(request.id, {
        taskId,
        sessionId,
        hostId,
        value: { ...request, selection: undefined },
      });
    }
  }
  update(
    taskId: number,
    hostId: string,
    values: readonly BrowserHumanRequest[],
  ): void {
    for (const value of values) {
      const entry = this.records.get(value.id);
      if (
        !entry ||
        entry.taskId !== taskId ||
        entry.hostId !== hostId ||
        entry.sessionId !== value.sessionId ||
        entry.value.tabId !== value.tabId ||
        entry.value.kind !== value.kind
      )
        continue;
      if (entry.value.status !== 'pending') continue;
      entry.value =
        value.status !== 'completed'
          ? { ...value, selection: undefined }
          : value;
      if (value.status !== 'pending') this.resolve(value.id, entry.value);
    }
    this.boundSnapshots();
  }
  private boundSnapshots(): void {
    const entries = [...this.records.values()].filter(entry => entry.value.selection?.snapshot?.jpeg);
    let bytes = entries.reduce((total, entry) => total + (entry.value.selection?.snapshot?.jpeg?.length ?? 0), 0);
    for (const entry of entries) {
      if (bytes <= 32 * 1024 * 1024) break;
      const selection = entry.value.selection!, snapshot = selection.snapshot!;
      bytes -= snapshot.jpeg!.length;
      entry.value = { ...entry.value, selection: { ...selection, snapshot: { reference: snapshot.reference, error: 'Snapshot bytes expired. Request a fresh selection for an image.' } } };
    }
  }
  get(taskId: number, sessionId: number, id: string): RecordEntry {
    this.sweep();
    const record = this.records.get(id);
    if (!record || record.taskId !== taskId || record.sessionId !== sessionId)
      throw new Error('Browser request unavailable to this conversation');
    return record;
  }
  wait(
    taskId: number,
    sessionId: number,
    id: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<BrowserHumanRequest> {
    signal.throwIfAborted();
    const record = this.get(taskId, sessionId, id);
    if (record.value.status !== 'pending') return Promise.resolve(record.value);
    const listeners = this.waiters.get(id) ?? new Set<Waiter>();
    if (listeners.size >= 4)
      return Promise.reject(new Error('Too many waiters for this request'));
    return new Promise((resolve, reject) => {
      const abort = () => {
        waiter.cleanup();
        reject(
          new Error(
            'Browser request wait cancelled; the request remains pending',
          ),
        );
      };
      const timer = setTimeout(() => {
        waiter.cleanup();
        try {
          resolve(this.get(taskId, sessionId, id).value);
        } catch {
          reject(new Error('Browser request expired'));
        }
      }, timeoutMs);
      const waiter: Waiter = {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          listeners.delete(waiter);
          if (!listeners.size) this.waiters.delete(id);
        },
      };
      listeners.add(waiter);
      this.waiters.set(id, listeners);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  disconnected(hostId: string): void {
    for (const [id, entry] of this.records)
      if (entry.hostId === hostId)
        for (const waiter of [...(this.waiters.get(id) ?? [])]) {
          waiter.cleanup();
          waiter.reject(
            new Error(
              'The browser disconnected. Inspect the request after reconnecting; no work was replayed.',
            ),
          );
        }
  }
  private resolve(id: string, value: BrowserHumanRequest): void {
    for (const waiter of [...(this.waiters.get(id) ?? [])]) {
      waiter.cleanup();
      waiter.resolve(value);
    }
  }
  sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.records) {
      if (entry.value.status === 'pending' && entry.value.expiresAt <= now) {
        entry.value = { ...entry.value, status: 'expired' };
        this.resolve(id, entry.value);
      }
      if (entry.value.expiresAt + 10 * 60 * 1000 <= now)
        this.records.delete(id);
    }
  }
  dispose(): void {
    for (const id of this.waiters.keys())
      for (const waiter of [...(this.waiters.get(id) ?? [])]) {
        waiter.cleanup();
        waiter.reject(new Error('Browser attention service stopped'));
      }
    this.records.clear();
  }
}
