import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { RuntimeBrowserStream } from './runtime-stream.js';
import { RuntimeBrowserController } from './runtime-browser.controller.js';
import { RuntimeBrowserService } from './runtime-browser.service.js';
import type { RuntimeBrowserPool } from './runtime-browser-pool.js';
import type { RuntimeBrowserPersistence } from './runtime-persistence.js';
import type { TasksService } from '../tasks/tasks.service.js';
import type { SessionsService } from '../sessions/sessions.service.js';
import type { TaskBrowserServers } from './task-browser-servers.js';

// Actual private socket + WebSocket parser + existing route validators. Blank
// tabs avoid depending on a host browser installation for transport regressions.
describe('private persistent browser channel', () => {
  let root: string,
    server: Server,
    tcp: Server,
    service: RuntimeBrowserService,
    gateway: RuntimeBrowserStream,
    token: string;
  const sockets: WebSocket[] = [];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'elevenex-browser-stream-'));
    service = new RuntimeBrowserService(
      { reservePort: () => undefined } as unknown as RuntimeBrowserPool,
      {
        read: () => Promise.resolve(null),
        save: () => Promise.resolve(true),
        flush: () => Promise.resolve(),
      } as unknown as RuntimeBrowserPersistence,
    );
    const routes = new RuntimeBrowserController(
      service,
      {
        record: () =>
          Promise.resolve({ id: 1, taskState: 'ready', archivedAt: null }),
      } as unknown as TasksService,
      {} as SessionsService,
      { ports: () => Promise.resolve([]) } as unknown as TaskBrowserServers,
    );
    gateway = new RuntimeBrowserStream(service);
    server = createServer();
    tcp = createServer();
    gateway.attachToServer(server, routes);
    // Use the same upgrade handlers, as the production edge proxy does.
    tcp.on('upgrade', (req, socket, head) =>
      server.emit('upgrade', req, socket, head),
    );
    server.listen(join(root, 'stream.sock'));
    await once(server, 'listening');
    tcp.listen(0, '127.0.0.1');
    await once(tcp, 'listening');
    token = (await service.connect(1, 'client', 'identity')).token;
  });
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await gateway.onModuleDestroy();
    await service.onModuleDestroy();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => tcp.close(() => resolve())),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  function open(
    headers: Record<string, string> = {},
    address?: string,
  ): WebSocket {
    const ws = new WebSocket(
      address ??
        `ws+unix://${join(root, 'stream.sock')}:/api/desktop-browser/runtime/tasks/1/stream`,
      { headers: { 'x-elevenex-browser-view': token, ...headers } },
    );
    sockets.push(ws);
    return ws;
  }
  it('pushes state without polling and multiplexes validated commands, receipts and lease heartbeat', async () => {
    const ws = open();
    const received: Record<string, unknown>[] = [];
    ws.on('message', (data) => {
      if (!Buffer.isBuffer(data)) throw new Error('Unexpected test packet');
      const value: unknown = JSON.parse(data.toString('utf8'));
      if (typeof value === 'object' && value !== null)
        received.push({ ...value });
    });
    await once(ws, 'open');
    ws.send(
      JSON.stringify({ id: 1, method: 'command', body: { kind: 'new-tab' } }),
    );
    while (!received.some((value) => value.id === 1)) await once(ws, 'message');
    expect(received.some((value) => value.event === 'state')).toBe(true);
    expect(received.find((value) => value.id === 1)).toMatchObject({
      result: { tabs: [expect.objectContaining({ by: 'you' })] },
    });
    const changed = once(ws, 'message');
    await service.active(1)!.command({ kind: 'new-tab' }); // Another owner, no HTTP refresh.
    await changed;
    expect(
      received.filter((value) => value.event === 'state').length,
    ).toBeGreaterThan(1);
    ws.send(
      JSON.stringify({
        id: 2,
        method: 'input',
        body: {
          tabId: 'bad',
          generation: 1,
          input: { kind: 'text', text: 'private' },
        },
      }),
    );
    while (!received.some((value) => value.id === 2)) await once(ws, 'message');
    expect(received.find((value) => value.id === 2)).toEqual({
      id: 2,
      failed: true,
    });
    expect(JSON.stringify(received)).not.toContain('private');
    ws.send(JSON.stringify({ id: 3, method: 'ping' }));
    while (!received.some((value) => value.id === 3)) await once(ws, 'message');
    expect(received.find((value) => value.id === 3)).toEqual({
      id: 3,
      result: null,
    });
    ws.close();
    await once(ws, 'close');
    expect(service.active(1)?.state().tabs).toHaveLength(2);
  });
  it('rejects TCP, browser origins and invalid tokens before upgrade', async () => {
    const address = tcp.address();
    if (!address || typeof address === 'string')
      throw new Error('TCP test unavailable');
    for (const connect of [
      () => open({ origin: 'https://page.example' }),
      () => open({ 'x-elevenex-browser-view': 'invalid' }),
      () =>
        open(
          {},
          `ws://127.0.0.1:${address.port}/api/desktop-browser/runtime/tasks/1/stream`,
        ),
    ]) {
      const ws = connect();
      const opened = jest.fn();
      ws.on('open', opened);
      ws.on('error', () => undefined);
      await new Promise<void>((resolve) => ws.once('close', () => resolve()));
      expect(opened).not.toHaveBeenCalled();
    }
  });
  it('allows only one persistent channel per viewer lease', async () => {
    const first = open();
    await once(first, 'open');
    const duplicate = open();
    duplicate.on('error', () => undefined);
    await new Promise<void>((resolve) =>
      duplicate.once('close', () => resolve()),
    );
    expect(first.readyState).toBe(WebSocket.OPEN);
    first.close();
    await once(first, 'close');
  });
  it('accepts one-way video receipts without replies and keeps starts request/response', async () => {
    const ws = open(),
      received: Record<string, unknown>[] = [];
    ws.on('message', (data) => {
      if (!Buffer.isBuffer(data)) throw new Error('Unexpected test packet');
      const value: unknown = JSON.parse(data.toString());
      if (typeof value === 'object' && value !== null)
        received.push({ ...value });
    });
    await once(ws, 'open');
    const body = {
      tabId: '11111111-1111-4111-8111-111111111111',
      subscription: '22222222-2222-4222-8222-222222222222',
      action: 'ack',
      sequence: 0,
      oneWay: true,
    };
    ws.send(JSON.stringify({ id: 1, method: 'video', body }));
    ws.send(JSON.stringify({ id: 2, method: 'ping' }));
    while (!received.some((item) => item.id === 2)) await once(ws, 'message');
    expect(received.some((item) => item.id === 1)).toBe(false);
    ws.send(
      JSON.stringify({
        id: 3,
        method: 'video',
        body: { ...body, action: 'start' },
      }),
    );
    while (!received.some((item) => item.id === 3)) await once(ws, 'message');
    expect(received.find((item) => item.id === 3)?.failed).toBe(true);
  });
  it('closes duplicate request IDs and rejects a superseded lease without replay', async () => {
    const ws = open();
    await once(ws, 'open');
    ws.send(
      JSON.stringify({ id: 1, method: 'command', body: { kind: 'new-tab' } }),
    );
    ws.send(
      JSON.stringify({ id: 1, method: 'command', body: { kind: 'new-tab' } }),
    );
    await once(ws, 'close');
    expect(service.active(1)?.tabs.size).toBeLessThanOrEqual(1);
    const fresh = await service.connect(1, 'client', 'identity');
    expect(() => service.viewer(1, token)).toThrow();
    token = fresh.token;
  });
});
