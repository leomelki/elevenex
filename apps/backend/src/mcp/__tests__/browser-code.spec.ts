import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServerFactory } from '../transport/mcp-server.factory.js';
import { ToolRegistryService } from '../tool-registry/tool-registry.service.js';
import { DeltaCursorStore } from '../tool-registry/delta-cursor.store.js';
import { DeepLinkBuilder } from '../deep-link/deep-link.builder.js';
import { AgentHumanChannelService } from '../human-channel/human-channel.js';
import { McpConnectionRegistryService } from '../connection/mcp-connection-registry.service.js';
import type { McpToolServices } from '../tool-registry/mcp-tool-services.js';

describe('Code-first browser over the real MCP SDK', () => {
  it('discovers two tools, defaults task scope, emits native image blocks and gates identity', async () => {
    const image = {
      data: '/9j/2Q==',
      mimeType: 'image/jpeg',
      width: 100,
      height: 60,
    };
    const requestCode = jest.fn().mockResolvedValue({
      sandboxId: 'sandbox',
      value: 42,
      logs: [],
      images: [image],
    });
    const services = {
      sessions: {
        findOne: () =>
          Promise.resolve({
            id: 42,
            workspaceId: 5,
            surface: 'session',
            status: 'idle',
          }),
      },
      tasks: {
        record: () =>
          Promise.resolve({ id: 5, taskState: 'ready', archivedAt: null }),
      },
      browsers: { requestCode, desktops: () => [] },
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
    const client = new Client({ name: 'browser-code-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    try {
      const listed = await client.listTools();
      expect(
        listed.tools
          .filter((tool) => tool.name.startsWith('browser_'))
          .map((tool) => tool.name)
          .sort(),
      ).toEqual(['browser_reset', 'browser_run']);
      const guide = await client.callTool({
        name: 'browser_run',
        arguments: {},
      });
      expect(JSON.stringify(guide.structuredContent)).toContain(
        'browser.tabs.new',
      );
      expect(requestCode).not.toHaveBeenCalled();
      const result = await client.callTool({
        name: 'browser_run',
        arguments: { code: 'return 42' },
      });
      expect(requestCode).toHaveBeenCalledWith(
        5,
        42,
        { kind: 'code', code: 'return 42', timeoutMs: 15000 },
        expect.any(AbortSignal),
        undefined,
      );
      expect(result.content).toEqual([
        {
          type: 'text',
          text: JSON.stringify({
            data: {
              sandboxId: 'sandbox',
              value: 42,
              logs: [],
              images: [{ image: 1, width: 100, height: 60 }],
            },
          }),
        },
        { type: 'image', data: image.data, mimeType: image.mimeType },
      ]);
      expect(JSON.stringify(result.structuredContent)).not.toContain(
        image.data,
      );
      requestCode.mockResolvedValueOnce({
        sandboxId: 'sandbox',
        value: null,
        logs: [],
        images: [],
        error: { message: 'Fix the selector', outcomeUnknown: false },
      });
      expect(
        (
          await client.callTool({
            name: 'browser_run',
            arguments: { code: 'throw new Error()' },
          })
        ).isError,
      ).toBe(true);
      expect(
        (
          await client.callTool({
            name: 'browser_run',
            arguments: { taskId: 9, code: 'return 1' },
          })
        ).isError,
      ).toBe(true);
      expect(
        (
          await client.callTool({
            name: 'browser_run',
            arguments: { code: 'x'.repeat(65537) },
          })
        ).isError,
      ).toBe(true);
      await client.callTool({ name: 'browser_reset', arguments: {} });
      expect(requestCode).toHaveBeenLastCalledWith(
        5,
        42,
        { kind: 'code', code: '', timeoutMs: 1000, reset: true },
        expect.any(AbortSignal),
        undefined,
      );
      identity = null;
      expect(
        (
          await client.callTool({
            name: 'browser_run',
            arguments: { taskId: 5, code: 'return 1' },
          })
        ).isError,
      ).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
