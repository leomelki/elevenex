import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServerFactory } from '../transport/mcp-server.factory.js';
import { ToolRegistryService } from '../tool-registry/tool-registry.service.js';
import { DeltaCursorStore } from '../tool-registry/delta-cursor.store.js';
import { DeepLinkBuilder } from '../deep-link/deep-link.builder.js';
import { AgentHumanChannelService } from '../human-channel/human-channel.js';
import { McpConnectionRegistryService } from '../connection/mcp-connection-registry.service.js';
import type { McpToolServices } from '../tool-registry/mcp-tool-services.js';
import { ToolError } from '../tool-registry/tool.types.js';

describe('Port forwarding through the MCP SDK', () => {
  it('registers scoped tools, validates TCP inputs, gates anonymous callers and preserves live errors', async () => {
    const desktop = {
      desktopId: 'desktop-a',
      windowId: 'w1',
      mode: 'ssh',
      connectionLabel: 'Dev',
      defaultConnection: 'ssh',
    };
    const forward = {
      id: 12,
      projectId: 5,
      name: 'Preview',
      status: 'error',
      running: false,
      lastError: 'Port occupied',
      localUrl: 'http://127.0.0.1:5173',
    };
    const request = jest.fn().mockResolvedValue({
      desktop,
      forwards: [forward],
      total: 1,
      nextOffset: null,
      reused: true,
    });
    const services = {
      sessions: {
        findOne: jest.fn().mockResolvedValue({
          id: 42,
          projectId: 5,
          surface: 'session',
          name: 'Preview agent',
        }),
      },
      projects: {
        findOne: jest.fn().mockResolvedValue({ id: 5, name: 'App' }),
      },
      portForwarding: { desktops: () => [desktop], request },
    } as unknown as McpToolServices;
    let identity: number | null = 42;
    const registry = new ToolRegistryService(
      services,
      new DeltaCursorStore(),
      new DeepLinkBuilder(),
      new AgentHumanChannelService(),
      { resolveSessionId: () => Promise.resolve(identity) } as never,
      new McpConnectionRegistryService(),
      { invalidate: jest.fn() } as never,
    );
    const server = new McpServerFactory(registry).create();
    const client = new Client({ name: 'forwarding-test', version: '1' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      const names = ['list', 'get', 'create', 'start', 'stop', 'remove'].map(
        (name) => `${name}_port_forward${name === 'list' ? 's' : ''}`,
      );
      expect(
        listed.tools.filter((tool) => names.includes(tool.name)),
      ).toHaveLength(6);
      expect(
        listed.tools.find((tool) => tool.name === 'create_port_forward')
          ?.annotations,
      ).toMatchObject({ readOnlyHint: false, idempotentHint: true });
      const created = await client.callTool({
        name: 'create_port_forward',
        arguments: { remotePort: 5173 },
      });
      expect(created.structuredContent).toMatchObject({
        data: { forwards: [forward], reused: true },
        deepLink: '/projects/5#ssh-forwarding',
        nextStep: expect.stringContaining('lastError') as unknown,
      });
      expect(request).toHaveBeenCalledWith(
        'create',
        expect.objectContaining({
          projectId: 5,
          remotePort: 5173,
          remoteHost: 'localhost',
          startImmediately: true,
          requestedBy: { sessionId: 42, sessionName: 'Preview agent' },
        }),
        expect.any(AbortSignal),
        undefined,
      );
      for (const args of [
        { remotePort: 0 },
        { remotePort: 65536 },
        { remotePort: 1.5 },
        { remotePort: 5173, sshHost: '-oProxyCommand=bad' },
        { remotePort: 5173, sshHost: '-v' },
      ]) {
        expect(
          (
            await client.callTool({
              name: 'create_port_forward',
              arguments: args,
            })
          ).isError,
        ).toBe(true);
      }
      expect(request).toHaveBeenCalledTimes(1);
      await client.callTool({
        name: 'stop_port_forward',
        arguments: { projectId: 9, forwardId: 12 },
      });
      expect(request).toHaveBeenLastCalledWith(
        'stop',
        expect.objectContaining({ projectId: 9, forwardId: 12 }),
        expect.any(AbortSignal),
        undefined,
      );
      request.mockRejectedValueOnce(
        new ToolError({
          code: 'desktop_timeout',
          message: 'No response',
          retryable: true,
        }),
      );
      const failure = await client.callTool({
        name: 'get_port_forward',
        arguments: { forwardId: 12 },
      });
      expect(failure.structuredContent).toMatchObject({
        error: {
          code: 'desktop_timeout',
          details: { projectId: 5, projectName: 'App' },
        },
      });
      identity = null;
      const anonymous = await client.callTool({
        name: 'list_port_forwards',
        arguments: { projectId: 5 },
      });
      expect(anonymous.structuredContent).toMatchObject({
        error: { code: 'requires_agent_session' },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
