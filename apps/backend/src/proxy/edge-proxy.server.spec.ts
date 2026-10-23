import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import {
  createServer,
  get,
  request as httpRequest,
  Server as HttpServer,
  ServerResponse,
} from 'http';
import { Socket, createConnection } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { once } from 'events';
import WebSocket, { WebSocketServer } from 'ws';
import { createEdgeProxyServer } from './edge-proxy.server.js';

function createProxyFixture(upstreamPort: number): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'elevenex-edge-proxy-'));
  mkdirSync(join(repoRoot, 'apps', 'frontend'), { recursive: true });
  writeFileSync(
    join(repoRoot, 'apps', 'frontend', 'proxy.conf.json'),
    JSON.stringify({
      '/api': {
        target: `http://127.0.0.1:${upstreamPort}`,
      },
      '/claude-status': {
        target: `ws://127.0.0.1:${upstreamPort}`,
        ws: true,
      },
    }),
    'utf8',
  );

  return repoRoot;
}

const connections = new WeakMap<HttpServer, Set<Socket>>();

function listen(server: HttpServer): Promise<number> {
  const sockets = new Set<Socket>();
  connections.set(server, sockets);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected TCP server address'));
        return;
      }

      resolve(address.port);
    });
  });
}

async function close(server: HttpServer): Promise<void> {
  for (const socket of connections.get(server) ?? []) socket.destroy();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

describe('createEdgeProxyServer', () => {
  let upstreamServer: HttpServer;
  let upstreamWss: WebSocketServer;
  let proxyServer: HttpServer;
  let repoRoot: string;

  async function startProxy(): Promise<string> {
    const upstreamPort = await listen(upstreamServer);
    repoRoot = createProxyFixture(upstreamPort);
    proxyServer = createEdgeProxyServer({ repoRoot });
    return `http://127.0.0.1:${await listen(proxyServer)}`;
  }

  afterEach(async () => {
    for (const ws of upstreamWss?.clients ?? []) ws.terminate();
    upstreamWss?.close();

    if (proxyServer?.listening) {
      await close(proxyServer);
    }

    if (upstreamServer?.listening) {
      await close(upstreamServer);
    }

    if (repoRoot) {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('proxies configured HTTP requests to the upstream backend', async () => {
    upstreamServer = createServer((request, response) => {
      if (request.url === '/api/ping?value=1') {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            ok: true,
            host: request.headers.host,
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end();
    });

    const upstreamPort = await listen(upstreamServer);
    repoRoot = createProxyFixture(upstreamPort);
    proxyServer = createEdgeProxyServer({ repoRoot });
    const proxyPort = await listen(proxyServer);

    const response = await fetch(
      `http://127.0.0.1:${proxyPort}/api/ping?value=1`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      host: `127.0.0.1:${upstreamPort}`,
    });
  });

  it('proxies configured websocket upgrades to the upstream backend', async () => {
    upstreamServer = createServer();
    upstreamWss = new WebSocketServer({ noServer: true });

    upstreamServer.on('upgrade', (request, socket, head) => {
      if (request.url?.startsWith('/claude-status')) {
        upstreamWss.handleUpgrade(request, socket, head, (ws) => {
          upstreamWss.emit('connection', ws, request);
        });
        return;
      }

      socket.destroy();
    });

    upstreamWss.on('connection', (ws) => {
      ws.on('message', (data) => {
        ws.send(`echo:${data.toString()}`);
      });
    });

    const upstreamPort = await listen(upstreamServer);
    repoRoot = createProxyFixture(upstreamPort);
    proxyServer = createEdgeProxyServer({ repoRoot });
    const proxyPort = await listen(proxyServer);

    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/claude-status`);
    await once(client, 'open');
    client.send('hello');

    const [message] = await once(client, 'message');
    expect(message.toString()).toBe('echo:hello');

    const closed = once(client, 'close');
    client.close();
    await closed;
  });

  it('keeps a slow response alive after a POST upload completes', async () => {
    let finishResponse!: () => void;
    const uploadEnded = new Promise<string>((resolve) => {
      upstreamServer = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => {
          body += chunk.toString();
        });
        request.on('end', () => {
          response.write('first\n');
          finishResponse = () => response.end('last\n');
          resolve(body);
        });
      });
    });
    const origin = await startProxy();
    const response = await fetch(`${origin}/api/search`, {
      method: 'POST',
      body: 'query',
    });
    expect(await uploadEnded).toBe('query');
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      'first\n',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    finishResponse();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      'last\n',
    );
    expect((await reader.read()).done).toBe(true);
  });

  it('cancels upstream NDJSON work when the downstream reader disconnects', async () => {
    let upstreamResponse!: ServerResponse;
    upstreamServer = createServer((_request, response) => {
      upstreamResponse = response;
      response.setHeader('Content-Type', 'application/x-ndjson');
      response.write('{"match":1}\n');
    });
    const origin = await startProxy();
    const response = await fetch(`${origin}/api/search`);
    const reader = response.body!.getReader();
    await reader.read();
    const cancelled = once(upstreamResponse, 'close');
    await reader.cancel();
    await cancelled;
    expect(upstreamResponse.writableFinished).toBe(false);
  });

  it('cancels upstream work when the client disconnects before response headers', async () => {
    let received!: (response: ServerResponse) => void;
    const upstreamReceived = new Promise<ServerResponse>((resolve) => {
      received = resolve;
    });
    upstreamServer = createServer((_request, response) => received(response));
    const origin = await startProxy();
    const client = get(`${origin}/api/search`);
    client.on('error', () => {});
    const response = await upstreamReceived;
    const cancelled = once(response, 'close');
    client.destroy();
    await cancelled;
    expect(response.destroyed).toBe(true);
  });

  it('cancels an incomplete upload when the client aborts', async () => {
    let received!: (request: import('http').IncomingMessage) => void;
    const upstreamReceived = new Promise<import('http').IncomingMessage>(
      (resolve) => {
        received = resolve;
      },
    );
    upstreamServer = createServer((request) => {
      request.on('error', () => {});
      request.once('data', () => received(request));
    });
    const origin = await startProxy();
    const client = httpRequest(`${origin}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Length': 100 },
    });
    client.on('error', () => {});
    client.write('partial');
    const request = await upstreamReceived;
    const cancelled = new Promise<void>((resolve) =>
      request.once('aborted', resolve),
    );
    client.destroy();
    await cancelled;
    expect(request.complete).toBe(false);
  });

  it('fails a truncated upstream response instead of completing partial NDJSON', async () => {
    let upstreamResponse!: ServerResponse;
    upstreamServer = createServer((_request, response) => {
      upstreamResponse = response;
      response.write('{"match":1}\n');
    });
    const origin = await startProxy();
    const response = await fetch(`${origin}/api/search`);
    const reader = response.body!.getReader();
    await reader.read();
    upstreamResponse.destroy();
    await expect(reader.read()).rejects.toThrow();
  });

  it('returns 502 when upstream fails before sending headers', async () => {
    upstreamServer = createServer((request) => request.socket.destroy());
    const origin = await startProxy();
    const response = await fetch(`${origin}/api/search`);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      message: 'Elevenex proxy request failed',
    });
  });

  it.each(['client', 'upstream'])(
    'closes the websocket peer after an abrupt %s disconnect',
    async (side) => {
      upstreamServer = createServer();
      upstreamWss = new WebSocketServer({ server: upstreamServer });
      const connected = once(upstreamWss, 'connection');
      const origin = await startProxy();
      const client = new WebSocket(
        `${origin.replace('http:', 'ws:')}/claude-status`,
      );
      await once(client, 'open');
      const [peer] = (await connected) as [WebSocket];
      const closed = once(side === 'client' ? peer : client, 'close');
      (side === 'client' ? client : peer).terminate();
      await closed;
    },
  );

  it('preserves a normal upstream websocket close code and reason', async () => {
    upstreamServer = createServer();
    upstreamWss = new WebSocketServer({ server: upstreamServer });
    const connected = once(upstreamWss, 'connection');
    const origin = await startProxy();
    const client = new WebSocket(
      `${origin.replace('http:', 'ws:')}/claude-status`,
    );
    await once(client, 'open');
    const [peer] = (await connected) as [WebSocket];
    const closed = once(client, 'close');
    peer.close(4000, 'Terminal process exited');
    const [code, reason] = await closed;
    expect(code).toBe(4000);
    expect(reason.toString()).toBe('Terminal process exited');
  });

  it('cancels a pending websocket connection and removes its connect listener', async () => {
    upstreamServer = createServer();
    const origin = new URL(await startProxy());
    const client = createConnection(Number(origin.port), '127.0.0.1');
    await once(client, 'connect');
    const pending = new Socket();
    let connecting!: () => void;
    const started = new Promise<void>((resolve) => {
      connecting = resolve;
    });
    const connect = jest
      .spyOn(Socket.prototype, 'connect')
      .mockImplementationOnce(() => {
        connecting();
        return pending;
      });
    try {
      client.write(
        'GET /claude-status HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      );
      await started;
      const closed = once(pending, 'close');
      client.destroy();
      await closed;
      expect(pending.destroyed).toBe(true);
      expect(pending.listenerCount('connect')).toBe(0);
      expect(pending.listenerCount('error')).toBe(0);
    } finally {
      connect.mockRestore();
      client.destroy();
      pending.destroy();
    }
  });

  it('returns 404 for routes not exposed by the proxy config', async () => {
    upstreamServer = createServer();

    const upstreamPort = await listen(upstreamServer);
    repoRoot = createProxyFixture(upstreamPort);
    proxyServer = createEdgeProxyServer({ repoRoot });
    const proxyPort = await listen(proxyServer);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/not-exposed`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      message: 'Route not exposed by Elevenex edge proxy',
    });
  });
});
