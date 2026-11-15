import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { ElevenexMcpHttpTransport } from './elevenex-mcp-http.transport.js';
import { McpAgentTokenService } from '../identity/mcp-agent-token.service.js';

/**
 * Harnesses speak HTTP, even when the desktop reaches us over a private socket.
 * Expose only authenticated MCP on an OS-assigned loopback port in that mode;
 * never open the backend's unauthenticated API/PTY routes on TCP.
 */
@Injectable()
export class McpAgentEndpointService implements OnModuleDestroy {
  private server: Server | null = null;
  private starting: Promise<void> | null = null;
  private destroyed = false;
  private endpoint: URL | null = null;
  private previousUrl: string | undefined;

  constructor(
    private readonly transport: ElevenexMcpHttpTransport,
    private readonly tokens: McpAgentTokenService,
  ) {}

  /** Bootstrap awaits this before app.init() can start missions or write config. */
  start(): Promise<void> {
    if (this.destroyed)
      return Promise.reject(new Error('MCP agent endpoint is closed.'));
    return (this.starting ??= this.listen());
  }

  private async listen(): Promise<void> {
    // Preserve external deployments and the legacy TCP endpoint verbatim.
    if (
      !process.env.ELEVENEX_DESKTOP_SOCKET ||
      process.env.ELEVENEX_MCP_URL?.trim()
    )
      return;
    this.previousUrl = process.env.ELEVENEX_MCP_URL;
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        // Never include credentials or request data in an HTTP error.
        if (res.headersSent) res.destroy();
        else res.writeHead(500).end();
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('MCP agent endpoint did not bind TCP.');
    this.endpoint = new URL(`http://127.0.0.1:${address.port}/api/mcp`);
    // This is application-owned process configuration, set before shell capture
    // and provider startup. All harnesses and the mission workspace use it.
    process.env.ELEVENEX_MCP_URL = this.endpoint.href;
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const endpoint = this.endpoint;
    if (this.destroyed || !endpoint) {
      res.writeHead(503).end();
      return;
    }
    if (req.url?.split('?')[0] !== endpoint.pathname) {
      res.writeHead(404).end();
      return;
    }
    // Harnesses send no Origin. Reject browser cross-origin access and DNS
    // rebinding as well as requiring a live session bearer on every request.
    if (
      req.headers.host !== endpoint.host ||
      (req.headers.origin && req.headers.origin !== endpoint.origin)
    ) {
      res.writeHead(403).end();
      return;
    }
    const token = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token || (await this.tokens.resolveSessionId(token)) === null) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
      return;
    }
    if (this.destroyed || res.destroyed) return;
    await this.transport.handle(req, res);
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    await this.starting?.catch(() => undefined);
    const server = this.server;
    if (server?.listening) {
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      // SSE responses are long lived; shutdown must not wait for clients.
      server.closeAllConnections();
      await closed;
    }
    if (this.endpoint && process.env.ELEVENEX_MCP_URL === this.endpoint.href) {
      if (this.previousUrl === undefined) delete process.env.ELEVENEX_MCP_URL;
      else process.env.ELEVENEX_MCP_URL = this.previousUrl;
    }
    this.server = null;
    this.endpoint = null;
  }
}
