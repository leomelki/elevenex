import { Injectable, Logger } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpServerFactory } from './mcp-server.factory.js';
import { DeltaCursorStore } from '../tool-registry/delta-cursor.store.js';
import { McpConnectionRegistryService } from '../connection/mcp-connection-registry.service.js';

interface LiveConnection {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

/**
 * Raw HTTP transport for the Streamable-HTTP MCP server, mounted as an Express
 * route at `/api/mcp` in the pre-body-parser block of main.ts so the transport
 * reads the raw request stream itself.
 *
 *  - POST without a session id → an initialize: spin up a server+transport,
 *    mint the `Mcp-Session-Id`, and remember it.
 *  - POST/GET/DELETE with a known session id → route to its transport
 *    (GET is the SSE notify channel; DELETE tears the session down).
 *
 * The bearer token is lifted off `Authorization` and attached as `req.auth` so
 * each tool call can resolve the agent-session identity from `extra.authInfo`.
 */
@Injectable()
export class ElevenexMcpHttpTransport {
  private readonly logger = new Logger(ElevenexMcpHttpTransport.name);
  private readonly connections = new Map<string, LiveConnection>();

  constructor(
    private readonly serverFactory: McpServerFactory,
    private readonly cursors: DeltaCursorStore,
    private readonly registry: McpConnectionRegistryService,
  ) {}

  /** Express handler. Mount: `app.use('/api/mcp', (req, res) => t.handle(req, res))`. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.attachAuth(req);
    const sessionId = this.headerSessionId(req);

    try {
      if (sessionId && this.connections.has(sessionId)) {
        await this.connections.get(sessionId)!.transport.handleRequest(req, res);
        return;
      }
      if (req.method === 'POST' && !sessionId) {
        await this.openNewConnection(req, res);
        return;
      }
      this.writeJsonError(
        res,
        sessionId ? 404 : 400,
        sessionId
          ? `Unknown or expired Mcp-Session-Id: ${sessionId}`
          : 'Missing Mcp-Session-Id (initialize first).',
      );
    } catch (err) {
      this.logger.error(
        `MCP request failed: ${err instanceof Error ? err.stack : String(err)}`,
      );
      if (!res.headersSent) this.writeJsonError(res, 500, 'Internal MCP error');
    }
  }

  private async openNewConnection(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const server = this.serverFactory.create();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        this.connections.set(sid, { transport, server });
        this.logger.debug(`MCP session initialized: ${sid}`);
      },
      onsessionclosed: (sid: string) => this.teardown(sid),
    });
    transport.onclose = () => {
      if (transport.sessionId) this.teardown(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  private teardown(sessionId: string): void {
    const conn = this.connections.get(sessionId);
    if (!conn) return;
    this.connections.delete(sessionId);
    this.cursors.clearConnection(sessionId);
    this.registry.remove(sessionId);
    void conn.server.close().catch(() => undefined);
    this.logger.debug(`MCP session closed: ${sessionId}`);
  }

  /** Parse `Authorization: Bearer <token>` into `req.auth` for tool handlers. */
  private attachAuth(req: IncomingMessage): void {
    const header = req.headers['authorization'];
    const value = Array.isArray(header) ? header[0] : header;
    const match = value?.match(/^Bearer\s+(.+)$/i);
    if (match) {
      (req as IncomingMessage & { auth?: unknown }).auth = {
        token: match[1].trim(),
        clientId: 'elevenex-agent',
        scopes: [],
      };
    }
  }

  private headerSessionId(req: IncomingMessage): string | undefined {
    const header = req.headers['mcp-session-id'];
    return Array.isArray(header) ? header[0] : header;
  }

  private writeJsonError(
    res: ServerResponse,
    status: number,
    message: string,
  ): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message },
        id: null,
      }),
    );
  }
}
