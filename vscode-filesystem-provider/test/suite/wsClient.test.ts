import * as assert from 'assert';
import { FileChangeEvent, FileChangeType } from 'vscode';
import { WebSocketClient } from '../../src/wsClient';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  static reset() {
    FakeWebSocket.instances = [];
  }

  emitOpen() {
    this.onopen?.();
  }

  emitMessage(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  emitClose() {
    this.onclose?.();
  }

  close() {
    this.readyState = 3;
  }
}

suite('WebSocketClient', () => {
  const originalWebSocket = (globalThis as typeof globalThis & { WebSocket?: unknown }).WebSocket;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const worktreePath = '/tmp/test-worktree';
  let timeoutCalls: Array<{ delay: number; callback: () => void; id: number }>;
  let timeoutId = 0;

  setup(() => {
    FakeWebSocket.reset();
    timeoutCalls = [];
    timeoutId = 0;
    (globalThis as any).WebSocket = FakeWebSocket;
    globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number) => {
      const id = ++timeoutId;
      timeoutCalls.push({
        id,
        delay: delay ?? 0,
        callback: () => callback(),
      });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
      timeoutCalls = timeoutCalls.filter((entry) => entry.id !== (id as unknown as number));
    }) as typeof clearTimeout;
  });

  teardown(() => {
    if (originalWebSocket) {
      (globalThis as typeof globalThis & { WebSocket: unknown }).WebSocket = originalWebSocket;
    } else {
      delete (globalThis as any).WebSocket;
    }
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  test('file events produce the expected exact FileChangeType', async () => {
    const client = new WebSocketClient(worktreePath, 'ws://localhost:3000');
    const batches: FileChangeEvent[][] = [];
    client.onDidChangeFile((changes) => batches.push(changes));

    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.emitMessage([
      { type: 'file-change', event: 'add', path: 'new.txt', worktreePath },
      { type: 'file-change', event: 'change', path: 'edited.txt', worktreePath },
      { type: 'file-change', event: 'unlink', path: 'gone.txt', worktreePath },
    ]);

    assert.strictEqual(batches.length, 1);
    assert.deepStrictEqual(
      batches[0].map((change) => ({ type: change.type, path: change.uri.path })),
      [
        { type: FileChangeType.Created, path: '/new.txt' },
        { type: FileChangeType.Changed, path: '/edited.txt' },
        { type: FileChangeType.Deleted, path: '/gone.txt' },
      ],
    );
  });

  test('directory events are still propagated to VS Code state', async () => {
    const client = new WebSocketClient(worktreePath, 'ws://localhost:3000');
    const batches: FileChangeEvent[][] = [];
    client.onDidChangeFile((changes) => batches.push(changes));

    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.emitMessage([
      { type: 'file-change', event: 'addDir', path: 'docs', worktreePath },
      { type: 'file-change', event: 'unlinkDir', path: 'old-docs', worktreePath },
    ]);

    assert.strictEqual(batches.length, 1);
    assert.deepStrictEqual(
      batches[0].map((change) => ({ type: change.type, path: change.uri.path })),
      [
        { type: FileChangeType.Created, path: '/docs' },
        { type: FileChangeType.Deleted, path: '/old-docs' },
      ],
    );
  });

  test('reconnection behavior still works after message parsing changes', () => {
    const client = new WebSocketClient(worktreePath, 'ws://localhost:3000');

    client.connect();
    assert.strictEqual(FakeWebSocket.instances.length, 1);
    assert.strictEqual(
      FakeWebSocket.instances[0].url,
      `ws://localhost:3000/file-changes?worktreePath=${encodeURIComponent(worktreePath)}`,
    );

    FakeWebSocket.instances[0].emitClose();

    assert.strictEqual(timeoutCalls.length, 1);
    assert.strictEqual(timeoutCalls[0].delay, 1000);

    timeoutCalls[0].callback();

    assert.strictEqual(FakeWebSocket.instances.length, 2);
    assert.strictEqual(
      FakeWebSocket.instances[1].url,
      `ws://localhost:3000/file-changes?worktreePath=${encodeURIComponent(worktreePath)}`,
    );
  });
});
