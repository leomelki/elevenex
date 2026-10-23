import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InitializeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  ElevenexMcpHttpTransport,
  sessionIdleTimeout,
} from './elevenex-mcp-http.transport.js';
import { DeltaCursorStore } from '../tool-registry/delta-cursor.store.js';
import { McpConnectionRegistryService } from '../connection/mcp-connection-registry.service.js';
import type { McpServerFactory } from './mcp-server.factory.js';

// The transport only needs the factory contract. Keep unrelated runtime/native
// dependencies out of these tests, while exercising the actual HTTP MCP SDK.
jest.mock('./mcp-server.factory.js', () => ({ McpServerFactory: class {} }));

const headers = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-03-26',
};
const init = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('MCP HTTP logical session lifecycle', () => {
  let http: Server;
  let url: string;
  let transport: ElevenexMcpHttpTransport;
  let cursors: DeltaCursorStore;
  let registry: McpConnectionRegistryService;
  let servers: McpServer[];
  let factory: { create: jest.Mock };
  let longCall: ReturnType<typeof deferred>;
  let toolStarted: ReturnType<typeof deferred>;
  let aborted: boolean;
  const previousTimeout = process.env.ELEVENEX_MCP_IDLE_TIMEOUT_MS;

  beforeEach(async () => {
    process.env.ELEVENEX_MCP_IDLE_TIMEOUT_MS = '1000';
    servers = [];
    longCall = deferred();
    toolStarted = deferred();
    aborted = false;
    factory = {
      create: jest.fn((activity: (delta: 1 | -1) => void) => {
        const server = new McpServer({ name: 'test', version: '1' });
        server.registerTool('long', {}, async (_extra) => {
          activity(1);
          toolStarted.resolve();
          try {
            await new Promise<void>((resolve) => {
              const onAbort = () => {
                aborted = true;
                resolve();
              };
              _extra.signal.addEventListener('abort', onAbort, { once: true });
              void longCall.promise
                .then(resolve)
                .finally(() =>
                  _extra.signal.removeEventListener('abort', onAbort),
                );
            });
            return { content: [] };
          } finally {
            activity(-1);
          }
        });
        servers.push(server);
        jest.spyOn(server, 'close');
        return server;
      }),
    };
    cursors = new DeltaCursorStore();
    registry = new McpConnectionRegistryService();
    transport = new ElevenexMcpHttpTransport(
      factory as unknown as McpServerFactory,
      cursors,
      registry,
    );
    http = createServer((req, res) => {
      void transport.handle(req, res);
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/mcp`;
  });

  afterEach(async () => {
    longCall.resolve();
    await transport.onModuleDestroy();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    if (previousTimeout === undefined)
      delete process.env.ELEVENEX_MCP_IDLE_TIMEOUT_MS;
    else process.env.ELEVENEX_MCP_IDLE_TIMEOUT_MS = previousTimeout;
  });

  async function initialize() {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(init),
    });
    expect(response.status).toBe(200);
    await response.text();
    const sid = response.headers.get('mcp-session-id')!;
    expect(sid).toBeTruthy();
    registry.register(sid, 42);
    cursors.set(sid, 7, 'cursor');
    return sid;
  }
  function request(sid: string, body: unknown) {
    return fetch(url, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': sid },
      body: JSON.stringify(body),
    });
  }
  function expectReleased(sid: string) {
    expect(registry.get(sid)).toBeUndefined();
    expect(cursors.get(sid, 7)).toBeUndefined();
    expect(servers[0].close).toHaveBeenCalled();
  }

  it('expires an idle logical session and clears registration/cursors', async () => {
    const sid = await initialize();
    await delay(1150);
    expectReleased(sid);
    expect(
      (await request(sid, { jsonrpc: '2.0', id: 2, method: 'ping' })).status,
    ).toBe(404);
  });

  it('preserves the logical session across a standalone SSE disconnect', async () => {
    const sid = await initialize();
    const controller = new AbortController();
    const stream = await fetch(url, {
      headers: { ...headers, 'mcp-session-id': sid },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    controller.abort();
    await stream.text().catch(() => undefined);
    const ping = await request(sid, { jsonrpc: '2.0', id: 2, method: 'ping' });
    expect(ping.status).toBe(200);
    await ping.text();
    expect(registry.get(sid)).toBeDefined();
    expect(cursors.get(sid, 7)).toBe('cursor');
    expect(servers[0].close).not.toHaveBeenCalled();
  });

  it('does not expire an ongoing tool and starts a fresh idle period when it ends', async () => {
    const sid = await initialize();
    const response = request(sid, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'long' },
    });
    await toolStarted.promise;
    await delay(1150);
    expect(servers[0].close).not.toHaveBeenCalled();
    expect(registry.get(sid)).toBeDefined();
    longCall.resolve();
    await (await response).text();
    await delay(1150);
    expectReleased(sid);
  });

  it('closes an explicit logical DELETE and clears registration/cursors', async () => {
    const sid = await initialize();
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { ...headers, 'mcp-session-id': sid },
    });
    expect(response.status).toBe(200);
    await response.text();
    expectReleased(sid);
  });

  it('cleans failed connection setup', async () => {
    factory.create.mockImplementationOnce(() => {
      const server = new McpServer({ name: 'broken', version: '1' });
      servers.push(server);
      jest.spyOn(server, 'close');
      jest
        .spyOn(server, 'connect')
        .mockRejectedValue(new Error('connect failed'));
      return server;
    });
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(init),
    });
    expect(response.status).toBe(500);
    expect(servers[0].close).toHaveBeenCalledTimes(1);
  });

  it('cleans a JSON-RPC initialization error after the SDK allocated a session id', async () => {
    const create = factory.create.getMockImplementation()!;
    factory.create.mockImplementationOnce((activity) => {
      const server = create(activity) as McpServer;
      server.server.setRequestHandler(InitializeRequestSchema, async () => {
        throw new Error('initialize failed');
      });
      return server;
    });
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(init),
    });
    const sid = response.headers.get('mcp-session-id')!;
    expect(sid).toBeTruthy();
    expect(await response.text()).toContain('error');
    await delay(20);
    expect(servers[0].close).toHaveBeenCalled();
    expect(
      (await request(sid, { jsonrpc: '2.0', id: 2, method: 'ping' })).status,
    ).toBe(404);
  });

  it('cleans a malformed initialize that the SDK rejects without throwing', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: '{bad json',
    });
    expect(response.status).toBe(400);
    await response.text();
    await delay(10);
    expect(servers[0].close).toHaveBeenCalledTimes(1);
  });

  it('shutdown aborts active tools, closes all sessions and rejects subsequent initialization', async () => {
    const sid = await initialize();
    const response = request(sid, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'long' },
    })
      .then((r) => r.text())
      .catch(() => undefined);
    await toolStarted.promise;
    await transport.onModuleDestroy();
    await response;
    expect(aborted).toBe(true);
    expectReleased(sid);
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(init),
        })
      ).status,
    ).toBe(503);
  });
});

describe('MCP idle timeout configuration', () => {
  it.each([
    '',
    '0',
    '-1',
    '999',
    '1.5',
    'NaN',
    'Infinity',
    '86400001',
    ' 1000',
    '1e4',
  ])('rejects invalid value %j', (raw) => {
    expect(() => sessionIdleTimeout(raw)).toThrow(
      'ELEVENEX_MCP_IDLE_TIMEOUT_MS',
    );
  });
  it('accepts bounded integer milliseconds and supplies a default', () => {
    expect(sessionIdleTimeout(undefined)).toBe(900_000);
    expect(sessionIdleTimeout('1000')).toBe(1000);
    expect(sessionIdleTimeout('86400000')).toBe(86_400_000);
  });
});
