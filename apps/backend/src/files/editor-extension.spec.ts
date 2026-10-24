import { RequestPool } from '../../../../vscode-filesystem-provider/src/requestPool';
import { WebSocketClient } from '../../../../vscode-filesystem-provider/src/wsClient';
import { WorkspaceVfsProvider } from '../../../../vscode-filesystem-provider/src/fileSystemProvider';
import {
  compileWatchExclude,
  watchIncludes,
} from '../../../../vscode-filesystem-provider/src/watchRules';
import { toWorkspaceVfsUri } from '../../../../vscode-filesystem-provider/src/workspaceUri';

jest.mock(
  'vscode',
  () => {
    class Emitter {
      listeners = new Set<(value: unknown) => void>();
      event = (listener: (value: unknown) => void) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      };
      fire(value: unknown) {
        for (const listener of this.listeners) listener(value);
      }
      dispose() {
        this.listeners.clear();
      }
    }
    const from = (value: any): any => ({
      ...value,
      toString: () => JSON.stringify(value),
      with: (update: any) => from({ ...value, ...update }),
    });
    return {
      EventEmitter: Emitter,
      Disposable: class {
        constructor(private close: () => void) {}
        dispose() {
          this.close();
        }
      },
      Uri: { from },
      FileType: { File: 1, Directory: 2 },
      FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
      FileSystemError: {
        Unavailable: (message: string) => new Error(message),
        NoPermissions: () => new Error('Denied'),
      },
    };
  },
  { virtual: true },
);

class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = jest.fn();
  constructor() {
    Socket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

describe('editor extension resource bounds', () => {
  const originalFetch = globalThis.fetch;
  const originalSocket = globalThis.WebSocket;
  beforeEach(() => {
    jest.useFakeTimers();
    Socket.instances = [];
    globalThis.WebSocket = Socket as any;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalSocket;
    jest.useRealTimers();
  });

  it('times out stalled response bodies and aborts the actual fetch', async () => {
    let signal!: AbortSignal;
    globalThis.fetch = jest.fn(async (_url, init) => {
      signal = init!.signal as AbortSignal;
      return { ok: true, json: () => new Promise(() => undefined) } as any;
    });
    const pool = new RequestPool();
    const response = await pool.fetch('/stat');
    const body = response.json();
    const rejected = expect(body).rejects.toThrow('timed out');
    await jest.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(signal.aborted).toBe(true);
    expect((pool as any).active).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('bounds active and queued requests and empties both on cancellation', async () => {
    globalThis.fetch = jest.fn(() => new Promise(() => undefined));
    const pool = new RequestPool();
    const requests = Array.from({ length: 100 }, (_, i) =>
      pool.fetch(`/stat/${i}`).catch((error) => error),
    );
    await Promise.resolve();
    expect((pool as any).active).toBe(8);
    expect((pool as any).pending).toHaveLength(64);
    pool.cancel();
    await Promise.all(requests);
    expect((pool as any).active).toBe(0);
    expect((pool as any).pending).toHaveLength(0);
    expect((pool as any).controllers.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('exhausts sockets stalled in CONNECTING and never reconnects after dispose', async () => {
    const client = new WebSocketClient('/repo');
    const status: string[] = [];
    client.onStatus((value) => status.push(value));
    client.connect();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(status).toEqual(['error']);
    expect(Socket.instances).toHaveLength(5);
    client.dispose();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(Socket.instances).toHaveLength(5);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('resynchronizes after reconnect and ignores events from a superseded socket', async () => {
    const client = new WebSocketClient('/repo');
    const changes: unknown[] = [];
    client.onDidChangeFile((events) => changes.push(events));
    client.connect();
    const first = Socket.instances[0];
    first.open();
    const stale = first.onmessage;
    first.onclose?.();
    await jest.advanceTimersByTimeAsync(500);
    Socket.instances[1].open();
    stale?.({
      data: JSON.stringify({
        worktreePath: '/repo',
        event: 'change',
        path: 'stale',
      }),
    });
    expect(changes).toHaveLength(2); // Root invalidation on both connections.
    client.dispose();
    expect(jest.getTimerCount()).toBe(0);
  });
  it('deduplicates stat requests and honors recursive/exclude rules for events', async () => {
    const backend = {
      stat: jest.fn(async () => ({ type: 1, ctime: 0, mtime: 0, size: 0 })),
    };
    const socket = new WebSocketClient('/repo');
    const provider = new WorkspaceVfsProvider(backend as any, '/repo', socket);
    const root = toWorkspaceVfsUri('/repo');
    const file = toWorkspaceVfsUri('/repo', 'src/file.ts');
    await Promise.all([provider.stat(file), provider.stat(file)]);
    expect(backend.stat).toHaveBeenCalledTimes(1);
    const changes: any[] = [];
    provider.onDidChangeFile((events) => changes.push(...events));
    const watch = provider.watch(root, {
      recursive: false,
      excludes: ['**/*.tmp'],
    });
    socket.connect();
    Socket.instances[0].open();
    changes.length = 0;
    const send = (path: string) =>
      Socket.instances[0].onmessage?.({
        data: JSON.stringify({ worktreePath: '/repo', event: 'add', path }),
      });
    send('src/file.ts');
    send('root.tmp');
    expect(changes).toHaveLength(0);
    send('root.ts');
    expect(changes.some((change) => change.type === 2)).toBe(true);
    watch.dispose();
    changes.length = 0;
    send('other.ts');
    expect(changes).toHaveLength(0);
    provider.dispose();
  });
  it('rejects stale file metadata without invalidating unrelated root startup requests', async () => {
    const completions = new Map<string, (value: any) => void>();
    const backend = {
      stat: jest.fn(
        (_root, path) =>
          new Promise((resolve) => completions.set(path, resolve)),
      ),
    };
    const provider = new WorkspaceVfsProvider(backend as any, '/repo');
    const root = provider.stat(toWorkspaceVfsUri('/repo'));
    const file = provider.stat(toWorkspaceVfsUri('/repo', 'file.ts'));
    const stale = expect(file).rejects.toThrow('Workspace changed');
    (provider as any).acceptExternalChanges([
      { type: 1, uri: toWorkspaceVfsUri('/repo', 'file.ts') },
    ]);
    const metadata = { type: 1, ctime: 0, mtime: 0, size: 0 };
    completions.get('')!(metadata);
    completions.get('file.ts')!(metadata);
    await expect(root).resolves.toEqual(metadata);
    await stale;
    provider.dispose();
  });

  it('matches globstars, braces, character classes and folder boundaries', () => {
    const rules = ['**/generated/**', '**/*.{tmp,bak}', '[a-c].ts'].map(
      compileWatchExclude,
    );
    expect(watchIncludes('', 'src/good.ts', true, rules)).toBe(true);
    expect(watchIncludes('', 'src/generated/a.ts', true, rules)).toBe(false);
    expect(watchIncludes('', 'src/a.bak', true, rules)).toBe(false);
    expect(watchIncludes('', 'b.ts', true, rules)).toBe(false);
    expect(watchIncludes('src', 'src2/file.ts', true, [])).toBe(false);
  });
});
