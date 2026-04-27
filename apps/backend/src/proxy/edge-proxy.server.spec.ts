import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { createServer, Server as HttpServer } from 'http';
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

function listen(server: HttpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
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

  afterEach(async () => {
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
        response.end(JSON.stringify({
          ok: true,
          host: request.headers.host,
        }));
        return;
      }

      response.statusCode = 404;
      response.end();
    });

    const upstreamPort = await listen(upstreamServer);
    repoRoot = createProxyFixture(upstreamPort);
    proxyServer = createEdgeProxyServer({ repoRoot });
    const proxyPort = await listen(proxyServer);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/ping?value=1`);

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

    client.close();
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
