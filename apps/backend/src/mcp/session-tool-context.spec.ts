import { elevenexMcpUrl } from './session-tool-context.js';

describe('shared harness MCP URL', () => {
  beforeEach(() => {
    jest.replaceProperty(process, 'env', { ...process.env });
    delete process.env.ELEVENEX_MCP_URL;
    delete process.env.ELEVENEX_DESKTOP_SOCKET;
    delete process.env.ELEVENEX_PROXY_PORT;
    delete process.env.FRONTEND_PORT;
  });

  afterEach(() => jest.restoreAllMocks());

  it('keeps the legacy default and frontend port fallback', () => {
    expect(elevenexMcpUrl()).toBe('http://127.0.0.1:11111/api/mcp');
    process.env.FRONTEND_PORT = '23456';
    expect(elevenexMcpUrl()).toBe('http://127.0.0.1:23456/api/mcp');
  });

  it('refuses to silently configure an unrelated TCP backend in socket mode', () => {
    process.env.ELEVENEX_DESKTOP_SOCKET = '/private/backend.sock';
    expect(() => elevenexMcpUrl()).toThrow('MCP agent endpoint must start');
  });

  it('uses the published or explicit URL in either transport mode', () => {
    process.env.ELEVENEX_MCP_URL = ' http://127.0.0.1:34567/api/mcp ';
    expect(elevenexMcpUrl()).toBe('http://127.0.0.1:34567/api/mcp');
    process.env.ELEVENEX_DESKTOP_SOCKET = '/private/backend.sock';
    expect(elevenexMcpUrl()).toBe('http://127.0.0.1:34567/api/mcp');
  });
});
