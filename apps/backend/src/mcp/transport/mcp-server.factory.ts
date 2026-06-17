import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolRegistryService } from '../tool-registry/tool-registry.service.js';
import { ELEVENEX_SERVER_INSTRUCTIONS } from '../server-instructions.js';

/** Server metadata advertised to clients on initialize. */
const SERVER_INFO = { name: 'elevenex', version: '0.1.0' } as const;

/**
 * Builds a fresh `McpServer` per connection (the SDK pattern is one
 * server+transport per `Mcp-Session-Id`). All connections share the same tool
 * set and instructions; per-connection identity is resolved per call from the
 * bearer token, so the server objects themselves are stateless and cheap.
 */
@Injectable()
export class McpServerFactory {
  constructor(private readonly registry: ToolRegistryService) {}

  create(): McpServer {
    const server = new McpServer(SERVER_INFO, {
      instructions: ELEVENEX_SERVER_INSTRUCTIONS,
      capabilities: {
        tools: { listChanged: true },
        logging: {},
      },
    });
    this.registry.registerAll(server);
    return server;
  }
}
