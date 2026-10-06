import elevenexAgentExtension from './pi-agent-extension.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { readFile } from 'fs/promises';

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn(),
}));
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn(),
}));
jest.mock('fs/promises', () => ({ readFile: jest.fn() }));

describe('Pi mission extension', () => {
  const originalEnv = { ...process.env };
  const client = {
    connect: jest.fn(),
    listTools: jest.fn(),
    callTool: jest.fn(),
    close: jest.fn(),
  };
  let handlers: Map<
    string,
    (event?: unknown, ctx?: unknown) => Promise<unknown>
  >;
  let pi: { on: jest.Mock; registerTool: jest.Mock; setActiveTools: jest.Mock };
  const status = jest.fn();

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.ELEVENEX_MCP_URL = 'http://127.0.0.1:11111/api/mcp';
    process.env.ELEVENEX_AGENT_TOKEN = 'test-token';
    process.env.ELEVENEX_AGENT_PROMPT = '/tmp/prompt.txt';
    jest.mocked(Client).mockImplementation(() => client as never);
    client.listTools.mockResolvedValue({
      tools: [
        {
          name: 'project_overview',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });
    handlers = new Map();
    pi = {
      on: jest.fn((name, handler) => handlers.set(name, handler)),
      registerTool: jest.fn(),
      setActiveTools: jest.fn(),
    };
    elevenexAgentExtension(pi);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('registers authenticated MCP tools, disables built-in tools, and signals readiness', async () => {
    await handlers.get('session_start')!({}, { ui: { setStatus: status } });
    expect(client.connect).toHaveBeenCalled();
    expect(pi.setActiveTools).toHaveBeenCalledWith([
      'TodoWrite',
      'mcp__elevenex__project_overview',
    ]);
    expect(status).toHaveBeenCalledWith('elevenex_agent_ready', 'ready');
    const tool = pi.registerTool.mock.calls[1][0];
    const signal = new AbortController().signal;
    client.callTool.mockResolvedValue({
      content: [{ type: 'text', text: '{}' }],
    });
    await expect(
      tool.execute('tool-1', { projectId: 7 }, signal),
    ).resolves.toMatchObject({ content: [{ type: 'text', text: '{}' }] });
    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'project_overview', arguments: { projectId: 7 } },
      undefined,
      { signal, timeout: 660_000 },
    );
    await handlers.get('session_shutdown')!();
    expect(client.close).toHaveBeenCalled();
  });

  it('reloads the mission mandate each turn so autonomy updates apply', async () => {
    jest
      .mocked(readFile)
      .mockResolvedValueOnce('Review mandate')
      .mockResolvedValueOnce('Full mandate');
    await expect(handlers.get('before_agent_start')!()).resolves.toEqual({
      systemPrompt: 'Review mandate',
    });
    await expect(handlers.get('before_agent_start')!()).resolves.toEqual({
      systemPrompt: 'Full mandate',
    });
  });

  it('reports connection failures and leaves all tools disabled', async () => {
    client.connect.mockRejectedValue(new Error('offline'));
    await handlers.get('session_start')!({}, { ui: { setStatus: status } });
    expect(pi.setActiveTools).toHaveBeenCalledWith([]);
    expect(pi.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
      'TodoWrite',
    ]);
    expect(status.mock.calls[0][1]).toContain('offline');
  });
});
