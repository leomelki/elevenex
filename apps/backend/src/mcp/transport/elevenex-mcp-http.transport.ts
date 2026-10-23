import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
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
  sessionId?: string;
  activeTools: number;
  idleTimer?: NodeJS.Timeout;
  closed: boolean;
  transportClosed: boolean;
  closing?: Promise<void>;
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
export class ElevenexMcpHttpTransport implements OnModuleDestroy {
  private readonly logger = new Logger(ElevenexMcpHttpTransport.name);
  private readonly connections = new Map<string, LiveConnection>();

  private readonly opening = new Set<LiveConnection>();
  private readonly closing = new Set<Promise<void>>();
  private readonly idleTimeoutMs = sessionIdleTimeout(
    process.env.ELEVENEX_MCP_IDLE_TIMEOUT_MS,
  );
  private destroyed = false;

  constructor(
    private readonly serverFactory: McpServerFactory,
    private readonly cursors: DeltaCursorStore,
    private readonly registry: McpConnectionRegistryService,
  ) {}

  /** Express handler. Mount: `app.use('/api/mcp', (req, res) => t.handle(req, res))`. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.destroyed) {
      this.writeJsonError(res, 503, 'MCP server is shutting down');
      return;
    }
    this.attachAuth(req);
    const sessionId = this.headerSessionId(req);

    try {
      if (sessionId && this.connections.has(sessionId)) {
        const connection = this.connections.get(sessionId)!;
        this.touch(connection);
        await connection.transport.handleRequest(req, res);
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
    let connection: LiveConnection;
    const server = this.serverFactory.create((delta) => {
      connection.activeTools += delta;
      this.touch(connection);
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        if (connection.closed || this.destroyed) return;
        connection.sessionId = sid;
        this.connections.set(sid, connection);
        this.opening.delete(connection);
        this.touch(connection);
        this.logger.debug(`MCP session initialized: ${sid}`);
      },
      // DELETE is a logical close. An SSE response closing is not.
      onsessionclosed: () => {
        void this.teardown(connection);
      },
    });
    connection = {
      transport,
      server,
      activeTools: 0,
      closed: false,
      transportClosed: false,
    };
    let awaitingInitializeResult = true;
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      try {
        await send(message, options);
      } catch (error) {
        if (awaitingInitializeResult) void this.teardown(connection);
        throw error;
      }
      if (
        awaitingInitializeResult &&
        ('result' in message || 'error' in message)
      ) {
        awaitingInitializeResult = false;
        if ('error' in message) void this.teardown(connection);
      }
    };
    // The SDK chains this callback when connect() installs its own onclose.
    transport.onclose = () => {
      connection.transportClosed = true;
      void this.teardown(connection);
    };
    this.opening.add(connection);
    this.touch(connection); // Also bounds an incomplete/malformed initialize.
    let initialized = false;
    try {
      await server.connect(transport);
      if (connection.closed) return;
      await transport.handleRequest(req, res);
      initialized = Boolean(connection.sessionId) && res.statusCode < 400;
    } finally {
      // The SDK may send a 4xx without throwing for an invalid initialize.
      if (!initialized) {
        await this.teardown(connection);
      }
    }
  }

  private touch(connection: LiveConnection): void {
    clearTimeout(connection.idleTimer);
    if (connection.closed || connection.activeTools > 0) return;
    connection.idleTimer = setTimeout(() => {
      void this.teardown(connection);
    }, this.idleTimeoutMs);
    connection.idleTimer.unref();
  }

  private teardown(connection: LiveConnection): Promise<void> {
    if (connection.closing) return connection.closing;
    connection.closed = true;
    clearTimeout(connection.idleTimer);
    this.opening.delete(connection);
    const sid = connection.sessionId ?? connection.transport.sessionId;
    if (sid) {
      this.connections.delete(sid);
      this.cursors.clearConnection(sid);
      this.registry.remove(sid);
    }
    // Defer close so reentrant SDK onclose callbacks see closing already set.
    connection.closing = Promise.resolve().then(async () => {
      await connection.server.close().catch(() => undefined);
      // connect() can fail before the SDK takes ownership of the transport.
      if (!connection.transportClosed)
        await connection.transport.close().catch(() => undefined);
      if (sid) {
        this.cursors.clearConnection(sid);
        this.registry.remove(sid);
      }
    });
    this.closing.add(connection.closing);
    void connection.closing.finally(() =>
      this.closing.delete(connection.closing!),
    );
    return connection.closing;
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    for (const connection of [...this.opening, ...this.connections.values()]) {
      void this.teardown(connection);
    }
    await Promise.allSettled([...this.closing]);
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

/** Reject invalid values rather than silently disabling expiry or overflowing a timer. */
export function sessionIdleTimeout(raw: string | undefined): number {
  if (raw === undefined) return 15 * 60_000;
  const value = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < 1000 ||
    value > 24 * 60 * 60_000
  ) {
    throw new Error(
      'ELEVENEX_MCP_IDLE_TIMEOUT_MS must be an integer from 1000 to 86400000',
    );
  }
  return value;
}
