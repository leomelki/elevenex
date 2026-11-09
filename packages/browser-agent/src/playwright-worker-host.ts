import { parentPort } from 'node:worker_threads';
import type {
  BrowserAgentDownload,
  BrowserAgentHost,
  BrowserAgentTarget,
} from './host.js';
import { object } from './host.js';
import type { BrowserHostSnapshot } from './playwright-channel.js';

interface TargetDescriptor {
  readonly key: string;
  readonly id: string;
}

/** Proxy for capabilities leased and revoked in main. A descriptor is never
 * reused after revocation, even when the human later hands back the same tab. */
export class WorkerBrowserHost implements BrowserAgentHost {
  readonly playwright = true;
  private next = 0;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private readonly listeners = new Set<() => void>();
  private readonly targets = new Map<
    string,
    {
      id: string;
      revoked: boolean;
      events: Set<
        (method: string, params: unknown, sessionId?: string) => void
      >;
      downloads: Set<(download: BrowserAgentDownload) => void>;
    }
  >();
  private snapshot: BrowserHostSnapshot = { rows: [], documents: [] };
  call(method: string, args: unknown[] = []): Promise<unknown> {
    if (this.pending.size >= 256)
      return Promise.reject(new Error('Browser host capacity exceeded'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      parentPort!.postMessage({ type: 'host', id, method, args });
    });
  }
  receive(raw: Record<string, unknown>): void {
    if (raw['type'] === 'snapshot') {
      this.snapshot = raw['value'] as unknown as BrowserHostSnapshot;
      for (const target of this.targets.values())
        if (
          !this.snapshot.rows.some((row) => row.id === target.id && row.owned)
        )
          target.revoked = true;
      for (const listener of this.listeners) listener();
    } else if (raw['type'] === 'host-reply') {
      const pending = this.pending.get(Number(raw['id']));
      if (!pending) return;
      this.pending.delete(Number(raw['id']));
      if (typeof raw['error'] === 'string')
        pending.reject(new Error(raw['error']));
      else pending.resolve(raw['value']);
    } else if (raw['type'] === 'target-event') {
      const target = this.targets.get(String(raw['key']));
      if (!target) return;
      if (raw['method'] === 'Elevenex.controlRevoked') target.revoked = true;
      if (!target.revoked || raw['method'] === 'Elevenex.controlRevoked')
        for (const listener of target.events)
          listener(
            String(raw['method']),
            raw['params'],
            typeof raw['sessionId'] === 'string' ? raw['sessionId'] : undefined,
          );
    } else if (raw['type'] === 'download') {
      const target = this.targets.get(String(raw['key']));
      if (!target || target.revoked) return;
      const key = String(raw['download']);
      const download: BrowserAgentDownload = {
        url: String(raw['url']),
        filename: String(raw['filename']),
        path: async () => String(await this.call('download-path', [key])),
        cancel: async () => {
          await this.call('download-cancel', [key]);
        },
        dispose: async () => {
          await this.call('download-dispose', [key]);
        },
      };
      for (const listener of target.downloads) listener(download);
    }
  }
  private target(value: unknown): BrowserAgentTarget {
    const descriptor = object(value) as unknown as TargetDescriptor;
    const state = {
      id: descriptor.id,
      revoked: false,
      events: new Set<
        (method: string, params: unknown, sessionId?: string) => void
      >(),
      downloads: new Set<(download: BrowserAgentDownload) => void>(),
    };
    this.targets.set(descriptor.key, state);
    const assert = () => {
      if (
        state.revoked ||
        !this.snapshot.rows.some((row) => row.id === state.id && row.owned)
      )
        throw new Error(
          'Browser control changed. Acquire a fresh page; a user stop requires Hand back.',
        );
    };
    const call = (method: string, args: unknown[] = []) => {
      assert();
      return this.call('target-' + method, [descriptor.key, ...args]);
    };
    return {
      id: descriptor.id,
      assert,
      send: (method, params, sessionId) =>
        call('send', [method, params, sessionId]),
      subscribe: (listener) => {
        state.events.add(listener);
        return () => state.events.delete(listener);
      },
      subscribeDownloads: (listener) => {
        state.downloads.add(listener);
        return () => state.downloads.delete(listener);
      },
      authorize: async (url) => {
        await call('authorize', [url]);
      },
      playwright: async () => {
        await call('playwright');
      },
      present: async (command, documentId, generation) => { await call('present', [command, documentId, generation]); },
      goto: async (url) => {
        await call('goto', [url]);
      },
      close: async () => {
        await call('close');
      },
      interrupt: () => {
        void call('interrupt').catch(() => undefined);
      },
      dispose: async () => {
        state.revoked = true;
        this.targets.delete(descriptor.key);
        await this.call('target-dispose', [descriptor.key]);
      },
    };
  }
  readonly profile = {
    cookies: async () =>
      (await this.call('cookies')) as Awaited<
        ReturnType<NonNullable<BrowserAgentHost['profile']>['cookies']>
      >,
    addCookies: async (
      cookies: Parameters<
        NonNullable<BrowserAgentHost['profile']>['addCookies']
      >[0],
    ) => {
      await this.call('addCookies', [cookies]);
    },
    clearCookies: async () => {
      await this.call('clearCookies');
    },
  };
  list(): BrowserHostSnapshot['rows'] {
    return this.snapshot.rows;
  }
  async acquire(_sessionId: number, tabId: string): Promise<void> {
    await this.call('acquire', [tabId]);
  }
  document(id: string): string | undefined {
    return this.snapshot.documents.find((row) => row[0] === id)?.[1];
  }
  watch(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  version(): Promise<string> {
    return this.call('version') as Promise<string>;
  }
  proxy(): Promise<string> {
    return this.call('proxy') as Promise<string>;
  }
  async authorizeUrl(url: string): Promise<void> {
    await this.call('authorizeUrl', [url]);
  }
  async interact(
    _sessionId: number,
    command: Parameters<NonNullable<BrowserAgentHost['interact']>>[1],
  ): ReturnType<NonNullable<BrowserAgentHost['interact']>> {
    return (await this.call('interact', [command])) as Awaited<
      ReturnType<NonNullable<BrowserAgentHost['interact']>>
    >;
  }
  async newPage(): Promise<BrowserAgentTarget> {
    return this.target(await this.call('newPage'));
  }
  async get(_sessionId: number, id: string): Promise<BrowserAgentTarget> {
    return this.target(await this.call('get', [id]));
  }
  async open(_sessionId: number, url: string): Promise<BrowserAgentTarget> {
    return this.target(await this.call('open', [url]));
  }
}
