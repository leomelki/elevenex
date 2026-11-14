import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { McpAgentTokenService } from '../identity/mcp-agent-token.service.js';
import { ElevenexMcpHttpTransport } from './elevenex-mcp-http.transport.js';

/** HTTP-only agent clients cannot connect to the desktop's private Unix socket. */
@Injectable()
export class McpAgentEndpointService implements OnModuleDestroy {
  private server?: Server;
  private preparation?: Promise<void>;
  private endpoint?: string;
  private stopping = false;

  constructor(
    private readonly transport: ElevenexMcpHttpTransport,
    private readonly tokens: McpAgentTokenService,
  ) {}

  /** Publish before module initialization can create agent configuration. */
  prepare(): Promise<void> {
    if (this.stopping)
      return Promise.reject(new Error('Agent MCP endpoint is shutting down.'));
    return (this.preparation ??= this.start());
  }

  private async start(): Promise<void> {
    // Keep legacy TCP defaults and explicitly configured external MCP endpoints.
    if (
      !process.env.ELEVENEX_DESKTOP_SOCKET ||
      process.env.ELEVENEX_MCP_URL?.trim()
    )
      return;
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (response.headersSent) response.destroy();
        else {
          response.writeHead(500);
          response.end('Agent MCP request failed.');
        }
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        reject(error);
      };
      server.once('error', failed);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', failed);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Invalid agent MCP listener address.');
    this.endpoint = `http://127.0.0.1:${address.port}/api/mcp`;
    process.env.ELEVENEX_MCP_URL = this.endpoint;
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    // This listener must never expose the private backend, browser pixels or WS gateways.
    if (request.url !== '/api/mcp') {
      response.writeHead(404);
      response.end();
      return;
    }
    if (this.stopping) {
      response.writeHead(503);
      response.end();
      return;
    }
    if (
      request.headers.origin !== undefined ||
      request.headers['sec-fetch-site'] !== undefined
    ) {
      response.writeHead(403);
      response.end();
      return;
    }
    const token =
      request.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if ((await this.tokens.resolveSessionId(token)) === null) {
      response.writeHead(401, {
        'WWW-Authenticate': 'Bearer realm="elevenex"',
      });
      response.end();
      return;
    }
    if (response.destroyed || this.stopping) {
      response.destroy();
      return;
    }
    await this.transport.handle(request, response);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.preparation?.catch(() => undefined);
    if (this.endpoint && process.env.ELEVENEX_MCP_URL === this.endpoint)
      delete process.env.ELEVENEX_MCP_URL;
    const server = this.server;
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
}
