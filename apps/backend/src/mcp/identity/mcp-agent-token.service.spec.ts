import { McpAgentTokenService } from './mcp-agent-token.service.js';

function fixture() {
  let token: string | null = null;
  let exists = true;
  const db = {
    select: jest.fn((fields) => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            exists ? [fields.token ? { token } : { id: 42 }] : [],
        }),
      }),
    })),
    update: jest.fn(() => ({
      set: (values: { mcpAgentToken: string }) => ({
        where: () => ({
          returning: async () => {
            if (!exists || token) return [];
            token = values.mcpAgentToken;
            return [{ token }];
          },
        }),
      }),
    })),
  };
  return {
    service: new McpAgentTokenService(db as never),
    second: new McpAgentTokenService(db as never),
    remove: () => {
      exists = false;
    },
    rotate: () => {
      token = 'new-token';
    },
  };
}

describe('MCP session tokens', () => {
  it('reuses a stable token for normal session restarts', async () => {
    const f = fixture();
    const token = await f.service.ensureToken(42);
    expect(token).toMatch(/^evx_/);
    expect(await f.service.ensureToken(42)).toBe(token);
    expect(await f.service.resolveSessionId(token)).toBe(42);
  });

  it('keeps the first token when separate providers initialize concurrently', async () => {
    const f = fixture();
    const tokens = await Promise.all([
      f.service.ensureToken(42),
      f.second.ensureToken(42),
    ]);
    expect(tokens[0]).toBe(tokens[1]);
    expect(await f.service.getToken(42)).toBe(tokens[0]);
  });

  it('revokes cached identity when the session is deleted', async () => {
    const f = fixture();
    const token = await f.service.ensureToken(42);
    f.remove();
    expect(await f.service.resolveSessionId(token)).toBeNull();
    await expect(f.service.ensureToken(42)).rejects.toThrow('not found');
  });

  it('rejects a cached token that has been replaced', async () => {
    const f = fixture();
    const token = await f.service.ensureToken(42);
    f.rotate();
    expect(await f.service.resolveSessionId(token)).toBeNull();
  });
});
