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
  it('reports native context during coding sessions without enabling mission tools', async () => {
    delete process.env.ELEVENEX_AGENT_TOKEN;
    pi.registerTool.mockClear();
    handlers.clear();
    elevenexAgentExtension(pi);
    const getContextUsage: jest.Mock = jest.fn().mockReturnValue({
      tokens: 25_000,
      contextWindow: 200_000,
      percent: 12.5,
    });
    const ctx = {
      ui: { setStatus: status },
      model: { provider: 'anthropic', id: 'sonnet' },
      getContextUsage,
    };
    await handlers.get('session_start')!({}, ctx);
    expect(pi.registerTool).not.toHaveBeenCalled();
    expect(pi.setActiveTools).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith(
      'elevenex_context_usage',
      JSON.stringify({
        model: 'anthropic/sonnet',
        usage: { tokens: 25_000, contextWindow: 200_000, percent: 12.5 },
        apiUsage: null,
      }),
    );
    getContextUsage.mockReturnValue({
      tokens: 60_000,
      contextWindow: 200_000,
      percent: 30,
    });
    await handlers.get('message_end')!({}, ctx);
    expect(JSON.parse(status.mock.calls.at(-1)![1]).usage.tokens).toBe(60_000);
    getContextUsage.mockReturnValue({
      tokens: null,
      contextWindow: 200_000,
      percent: null,
    });
    await handlers.get('session_compact')!({}, ctx);
    expect(JSON.parse(status.mock.calls.at(-1)![1]).usage.tokens).toBeNull();
  });
  it('throttles streamed reads and deduplicates unchanged context records', async () => {
    const getContextUsage = jest.fn().mockReturnValue({
      tokens: 25_000,
      contextWindow: 200_000,
      percent: 12.5,
    });
    const ctx = { ui: { setStatus: status }, getContextUsage };
    await handlers.get('message_end')!({}, ctx);
    await handlers.get('message_update')!({}, ctx);
    expect(getContextUsage).toHaveBeenCalledTimes(1);
    await handlers.get('message_end')!({}, ctx);
    expect(getContextUsage).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenCalledTimes(1);
  });
  it('hydrates branch usage and publishes input/output/cache breakdowns from final responses', async () => {
    delete process.env.ELEVENEX_AGENT_TOKEN;
    handlers.clear();
    elevenexAgentExtension(pi);
    const oldUsage = {
      input: 1_000,
      output: 500,
      cacheRead: 20_000,
      cacheWrite: 3_000,
    };
    const ctx = {
      ui: { setStatus: status },
      getContextUsage: () => ({
        tokens: 24_500,
        contextWindow: 200_000,
        percent: 12.25,
      }),
      sessionManager: {
        getBranch: () => [
          { type: 'message', message: { role: 'assistant', usage: oldUsage } },
        ],
      },
    };
    await handlers.get('session_start')!({}, ctx);
    expect(JSON.parse(status.mock.calls.at(-1)![1]).apiUsage).toEqual(oldUsage);
    const newUsage = { ...oldUsage, input: 2_000, output: 1_000 };
    await handlers.get('message_end')!(
      { message: { role: 'assistant', usage: newUsage } },
      ctx,
    );
    expect(JSON.parse(status.mock.calls.at(-1)![1]).apiUsage).toEqual(newUsage);
    await handlers.get('session_compact')!({}, ctx);
    expect(JSON.parse(status.mock.calls.at(-1)![1]).apiUsage).toBeNull();
  });
});
