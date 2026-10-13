import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { PiMcpBridge, type PiMcpTool } from './pi-mcp-bridge.js';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

jest.mock('node:fs/promises', () => ({ readFile: jest.fn() }));
jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn(),
}));
jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: jest.fn(),
}));
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn(),
}));
jest.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: jest.fn(),
}));

describe('Pi MCP client bridge', () => {
  let clients: {
    connect: jest.Mock;
    listTools: jest.Mock;
    callTool: jest.Mock;
    close: jest.Mock;
    onclose?: () => void;
  }[];
  beforeEach(() => {
    jest.resetAllMocks();
    clients = [];
    jest.mocked(Client).mockImplementation(() => {
      const client = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({
          tools: [{ name: 'lookup', inputSchema: { type: 'object' } }],
        }),
        callTool: jest
          .fn()
          .mockResolvedValue({ content: [{ type: 'text', text: 'result' }] }),
        close: jest.fn().mockResolvedValue(undefined),
      };
      clients.push(client);
      return client as never;
    });
  });

  it('loads user/project servers with project precedence and registers callable tools', async () => {
    jest
      .mocked(readFile)
      .mockResolvedValueOnce(
        JSON.stringify({ mcpServers: { docs: { command: 'old' } } }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          mcpServers: {
            docs: {
              command: 'node',
              args: ['server.js'],
              env: { TOKEN: 'key' },
            },
            disabled: { enabled: false, command: 'skip' },
          },
        }),
      );
    const bridge = new PiMcpBridge();
    const register = jest.fn<void, [PiMcpTool]>();
    const result = await bridge.connect(register);
    expect(clients).toHaveLength(1);
    expect(StdioClientTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'node',
        args: ['server.js'],
        env: { TOKEN: 'key' },
      }),
    );
    expect(result.names).toEqual(['mcp__docs__lookup']);
    expect(result.statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'disabled', status: 'disabled' }),
        expect.objectContaining({ name: 'docs', status: 'connected' }),
      ]),
    );
    const controller = new AbortController();
    expect(
      await register.mock.calls[0][0].execute(
        'id',
        { query: 'example' },
        controller.signal,
      ),
    ).toMatchObject({ content: [{ text: 'result' }] });
    expect(clients[0].callTool).toHaveBeenCalledWith(
      { name: 'lookup', arguments: { query: 'example' } },
      undefined,
      { signal: controller.signal, timeout: 660_000 },
    );
    await bridge.close();
    expect(clients[0].close).toHaveBeenCalledTimes(1);
  });

  it('keeps long tool names short and collision-free for model APIs', async () => {
    jest
      .mocked(readFile)
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(
        JSON.stringify({
          mcpServers: {
            ['a'.repeat(80)]: { command: 'node' },
            ['a'.repeat(79) + 'b']: { command: 'node' },
          },
        }),
      );
    const bridge = new PiMcpBridge();
    const result = await bridge.connect(jest.fn());
    expect(result.names.every((name) => name.length <= 64)).toBe(true);
    expect(new Set(result.names).size).toBe(2);
    await bridge.close();
  });

  it('reports lost connections and removes their available tools', async () => {
    jest
      .mocked(readFile)
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(
        JSON.stringify({ mcpServers: { docs: { command: 'node' } } }),
      );
    const bridge = new PiMcpBridge();
    const changed = jest.fn();
    await bridge.connect(jest.fn(), changed);
    clients[0].onclose?.();
    expect(changed).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'docs', status: 'failed', tools: [] }),
    ]);
    await bridge.close();
  });

  it('identifies authentication failures using the SDK error type', async () => {
    jest
      .mocked(readFile)
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(
        JSON.stringify({ mcpServers: { docs: { command: 'node' } } }),
      );
    jest.mocked(Client).mockImplementationOnce(
      () =>
        ({
          connect: jest.fn().mockRejectedValue(new UnauthorizedError()),
          close: jest.fn().mockResolvedValue(undefined),
        }) as never,
    );
    const bridge = new PiMcpBridge();
    expect((await bridge.connect(jest.fn())).statuses[0].status).toBe(
      'needs-auth',
    );
    await bridge.close();
  });

  it('isolates a failed server and closes its transport', async () => {
    jest
      .mocked(readFile)
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(
        JSON.stringify({
          mcpServers: {
            broken: { url: 'not a URL' },
            docs: { url: 'https://example.com/mcp' },
          },
        }),
      );
    const bridge = new PiMcpBridge();
    const result = await bridge.connect(jest.fn());
    expect(result.names).toEqual(['mcp__docs__lookup']);
    expect(result.statuses.find((s) => s.name === 'broken')?.status).toBe(
      'failed',
    );
    expect(clients[0].close).toHaveBeenCalledTimes(1);
    await bridge.close();
  });

  it('bounds a stalled handshake, preserves healthy servers and ignores late success', async () => {
    jest.useFakeTimers();
    const bridge = new PiMcpBridge();
    let finishHandshake!: () => void;
    const stalled = {
      connect: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finishHandshake = resolve;
          }),
      ),
      listTools: jest.fn(),
      callTool: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    jest.mocked(Client).mockImplementationOnce(() => stalled as never);
    jest
      .mocked(readFile)
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(
        JSON.stringify({
          mcpServers: {
            stalled: { command: 'node' },
            healthy: { command: 'node' },
          },
        }),
      );
    const register = jest.fn();
    try {
      const pending = bridge.connect(register);
      await jest.advanceTimersByTimeAsync(8_000);
      const result = await pending;
      expect(result.statuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'stalled',
            status: 'failed',
          }),
          expect.objectContaining({ name: 'healthy', status: 'connected' }),
        ]),
      );
      expect(
        result.statuses.find((server) => server.name === 'stalled')?.error,
      ).toContain('timed out');
      expect(stalled.close).toHaveBeenCalledTimes(1);
      finishHandshake();
      await jest.advanceTimersByTimeAsync(0);
      expect(stalled.listTools).not.toHaveBeenCalled();
      expect(register).toHaveBeenCalledTimes(1);
      expect(clients[0].close).not.toHaveBeenCalled();
    } finally {
      await bridge.close();
      jest.useRealTimers();
    }
  });

  it('cancels pending discovery on shutdown without registering tools afterwards', async () => {
    jest
      .mocked(readFile)
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce('{"mcpServers":{"docs":{"command":"node"}}}');
    let finishDiscovery!: (value: unknown) => void;
    const client = {
      connect: jest.fn().mockResolvedValue(undefined),
      listTools: jest.fn(
        () =>
          new Promise((resolve) => {
            finishDiscovery = resolve;
          }),
      ),
      close: jest.fn().mockResolvedValue(undefined),
    };
    jest.mocked(Client).mockImplementationOnce(() => client as never);
    const bridge = new PiMcpBridge();
    const register = jest.fn();
    const pending = bridge.connect(register);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await bridge.close();
    await pending;
    finishDiscovery({
      tools: [{ name: 'late', inputSchema: { type: 'object' } }],
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(register).not.toHaveBeenCalled();
  });

  it('excludes tools from a server that closes while another server is still connecting', async () => {
    jest
      .mocked(readFile)
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(
        JSON.stringify({
          mcpServers: {
            first: { command: 'node' },
            second: { command: 'node' },
          },
        }),
      );
    let finishDiscovery!: (value: unknown) => void;
    const first: (typeof clients)[number] = {
      connect: jest.fn().mockResolvedValue(undefined),
      listTools: jest.fn().mockResolvedValue({
        tools: [{ name: 'lookup', inputSchema: { type: 'object' } }],
      }),
      callTool: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const second = {
      ...first,
      listTools: jest.fn(
        () =>
          new Promise((resolve) => {
            finishDiscovery = resolve;
          }),
      ),
    };
    jest
      .mocked(Client)
      .mockImplementationOnce(() => first as never)
      .mockImplementationOnce(() => second as never);
    const bridge = new PiMcpBridge();
    try {
      const pending = bridge.connect(jest.fn());
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(first.onclose).toBeDefined();
      first.onclose!();
      finishDiscovery({
        tools: [{ name: 'lookup', inputSchema: { type: 'object' } }],
      });
      expect((await pending).names).toEqual(['mcp__second__lookup']);
    } finally {
      await bridge.close();
    }
  });
});
