import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServerFactory } from '../transport/mcp-server.factory.js';
import { ToolRegistryService } from '../tool-registry/tool-registry.service.js';
import { DeltaCursorStore } from '../tool-registry/delta-cursor.store.js';
import { DeepLinkBuilder } from '../deep-link/deep-link.builder.js';
import { AgentHumanChannelService } from '../human-channel/human-channel.js';
import { McpConnectionRegistryService } from '../connection/mcp-connection-registry.service.js';
import type { McpToolServices } from '../tool-registry/mcp-tool-services.js';
import { buildExportModel } from '../../agent-runtime/conversation-export.service.js';

describe('MCP SDK session workflow', () => {
  it('discovers configuration, forks history, and enforces containment through a real MCP client', async () => {
    const fork = jest.fn().mockResolvedValue({
      session: {
        id: 99,
        name: 'Fork',
        status: 'created',
        activeAgentProvider: 'codex',
      },
      draft: null,
    });
    const remove = jest.fn();
    const runtime = {
      info: {
        capabilities: { permissions: true, rewindConversation: true },
        permissionModes: ['default', 'auto'],
      },
      getRuntimeState: jest.fn().mockResolvedValue({
        selectedModel: 'model-1',
        history: ['must-not-leak'],
        permissionMode: 'auto',
      }),
      getModelCatalog: jest.fn().mockResolvedValue({
        models: [{ id: 'model-1', displayName: 'Model 1' }],
        reasoningEfforts: ['high'],
        providerDefaultModelId: 'model-1',
        supportsModelSelection: true,
      }),
      setPermissionMode: jest.fn(),
    };
    const transcript = buildExportModel(
      [
        { id: 'u1', kind: 'user', content: 'Implement auth', isError: false },
        { id: 'a1', kind: 'assistant', content: 'Done', isError: false },
      ],
      {
        title: 'Session',
        sessionId: 42,
        provider: 'codex',
        branch: 'feature',
        exportedAt: '',
      },
    );
    const services = {
      sessions: {
        findOne: jest.fn().mockResolvedValue({
          id: 42,
          projectId: 1,
          repoId: 5,
          workspaceId: 9,
          folderId: 3,
          surface: 'session',
          activeAgentProvider: 'codex',
          codexSessionId: 'thread1',
        }),
      },
      sessionForks: { create: fork },
      repos: { remove },
      conversationExport: {
        buildModel: jest.fn().mockResolvedValue({
          model: transcript,
          itemCount: 2,
          running: false,
        }),
      },
      agentRuntime: { getProvider: () => runtime },
    } as unknown as McpToolServices;
    const registry = new ToolRegistryService(
      services,
      new DeltaCursorStore(),
      new DeepLinkBuilder(),
      new AgentHumanChannelService(),
      {
        resolveSessionId: async (token?: string) =>
          token === 'test-token' ? 42 : null,
      } as never,
      new McpConnectionRegistryService(),
      { invalidate: jest.fn() } as never,
    );
    const server = new McpServerFactory(registry).create();
    const client = new Client({
      name: 'session-workflow-test',
      version: '1.0',
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    serverTransport.sessionId = 'sdk-test';
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) =>
      send(message, {
        ...options,
        authInfo: { token: 'test-token', clientId: 'test', scopes: [] },
      });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(
        listed.tools.find((tool) => tool.name === 'remove_repo')?.annotations
          ?.destructiveHint,
      ).toBe(true);
      expect(
        listed.tools.some((tool) => tool.name === 'get_session_config'),
      ).toBe(true);
      const config = await client.callTool({
        name: 'get_session_config',
        arguments: {},
      });
      expect(config.structuredContent).toMatchObject({
        data: {
          sessionId: 42,
          models: [{ id: 'model-1' }],
          permissionModes: expect.arrayContaining(['auto']),
        },
      });
      expect(JSON.stringify(config)).not.toContain('must-not-leak');
      const read = await client.callTool({
        name: 'read_session',
        arguments: { includeIds: true },
      });
      expect(read.structuredContent).toMatchObject({
        data: { delta: false, markdown: expect.stringContaining('a1') },
      });
      const forked = await client.callTool({
        name: 'fork_session',
        arguments: { anchorMessageId: 'a1', anchorMessageKind: 'assistant' },
      });
      expect(forked.structuredContent).toMatchObject({
        data: { sessionId: 99, forkedFrom: 42 },
      });
      expect(fork).toHaveBeenCalledWith(
        42,
        expect.objectContaining({
          anchorMessageId: 'a1',
          anchorMessageKind: 'assistant',
        }),
      );
      const invalid = await client.callTool({
        name: 'fork_session',
        arguments: {},
      });
      expect(invalid.isError).toBe(true);
      expect(fork).toHaveBeenCalledTimes(1);
      const selfDelete = await client.callTool({
        name: 'remove_repo',
        arguments: { repoId: 5 },
      });
      expect(selfDelete.structuredContent).toMatchObject({
        error: { code: 'self_target_not_allowed' },
      });
      expect(remove).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
