import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { PiMcpBridge, type PiMcpTool } from './pi-mcp-bridge.js';

describe('Pi MCP transports', () => {
  let directory: string;
  const originalEnv = { ...process.env };
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'elevenex-pi-mcp-'));
    process.env.PI_CODING_AGENT_DIR = directory;
    process.env.ELEVENEX_MCP_CWD = directory;
  });
  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('discovers and calls a tool over a real stdio child process', async () => {
    const script = join(directory, 'server.cjs');
    await fs.writeFile(
      script,
      `
      const { Server } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/index.js'))});
      const { StdioServerTransport } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'))});
      const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/types.js'))});
      const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object' } }] }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: 'text', text: request.params.arguments.message }] }));
      server.connect(new StdioServerTransport());
    `,
    );
    await fs.writeFile(
      join(directory, 'mcp.json'),
      JSON.stringify({
        mcpServers: { fixture: { command: process.execPath, args: [script] } },
      }),
    );
    const bridge = new PiMcpBridge();
    const register = jest.fn<void, [PiMcpTool]>();
    try {
      const result = await bridge.connect(register);
      if (result.statuses[0]?.status === 'failed')
        throw new Error(result.statuses[0].error);
      expect(result.statuses[0]).toMatchObject({
        name: 'fixture',
        status: 'connected',
      });
      expect(
        await register.mock.calls[0][0].execute('tool-id', {
          message: 'hello from stdio',
        }),
      ).toMatchObject({
        content: [{ type: 'text', text: 'hello from stdio' }],
      });
    } finally {
      await bridge.close();
    }
  });

  it('discovers and calls a tool over a real Streamable HTTP endpoint', async () => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
    });
    const mcp = new Server(
      { name: 'fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    mcp.setRequestHandler(ListToolsRequestSchema, () =>
      Promise.resolve({
        tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
      }),
    );
    mcp.setRequestHandler(CallToolRequestSchema, (request) =>
      Promise.resolve({
        content: [
          { type: 'text', text: String(request.params.arguments?.message) },
        ],
      }),
    );
    await mcp.connect(transport);
    const http = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const body: unknown = chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString())
          : undefined;
        await transport.handleRequest(request, response, body);
      })().catch((error: unknown) =>
        response.destroy(
          error instanceof Error ? error : new Error('Fixture request failed.'),
        ),
      );
    });
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', resolve);
    });
    const address = http.address() as { port: number };
    await fs.writeFile(
      join(directory, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          fixture: {
            type: 'http',
            url: `http://127.0.0.1:${address.port}/mcp`,
          },
        },
      }),
    );
    const bridge = new PiMcpBridge();
    const register = jest.fn<void, [PiMcpTool]>();
    try {
      const result = await bridge.connect(register);
      if (result.statuses[0]?.status === 'failed')
        throw new Error(result.statuses[0].error);
      expect(result.statuses[0]).toMatchObject({
        name: 'fixture',
        status: 'connected',
      });
      expect(
        await register.mock.calls[0][0].execute('tool-id', {
          message: 'hello from HTTP',
        }),
      ).toMatchObject({ content: [{ type: 'text', text: 'hello from HTTP' }] });
    } finally {
      await bridge.close();
      await mcp.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });

  it('times out a real SSE endpoint that never finishes opening', async () => {
    const http = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': waiting for endpoint\n\n');
    });
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', resolve);
    });
    const address = http.address() as { port: number };
    await fs.writeFile(
      join(directory, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          waiting: { type: 'sse', url: `http://127.0.0.1:${address.port}/sse` },
        },
      }),
    );
    const bridge = new PiMcpBridge();
    const register = jest.fn();
    try {
      const result = await bridge.connect(register);
      expect(result.statuses[0]).toMatchObject({
        name: 'waiting',
        status: 'failed',
      });
      expect(result.statuses[0].error).toContain('timed out');
      expect(register).not.toHaveBeenCalled();
    } finally {
      await bridge.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  }, 12_000);
});
