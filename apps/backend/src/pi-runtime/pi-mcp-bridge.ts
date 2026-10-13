import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

export interface PiMcpStatus {
  name: string;
  status: 'connected' | 'failed' | 'disabled' | 'needs-auth';
  tools: { name: string; displayName: string }[];
  error?: string;
}

export interface PiMcpTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    id: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

interface ServerConfig {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

/** SDK request options do not bound transport.start(), especially SSE's endpoint
 * handshake. Race the entire discovery, and handle late settlement after abort. */
function discoverBeforeAbort<T>(
  signal: AbortSignal,
  discover: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      const reason: unknown = signal.reason;
      reject(
        reason instanceof Error ? reason : new Error('MCP discovery canceled.'),
      );
    };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return discover();
      })
      .then(
        (value) => {
          signal.removeEventListener('abort', aborted);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', aborted);
          reject(
            error instanceof Error ? error : new Error('MCP discovery failed.'),
          );
        },
      );
  });
}

/** Pi extension bridge; one optional server failing never disables the other tools. */
export class PiMcpBridge {
  private readonly clients = new Set<Client>();
  private readonly controller = new AbortController();

  async connect(
    register: (tool: PiMcpTool) => void,
    onStatusChange?: (statuses: PiMcpStatus[]) => void,
  ): Promise<{ names: string[]; statuses: PiMcpStatus[] }> {
    const cwd = process.env.ELEVENEX_MCP_CWD || process.cwd();
    const files = [
      join(
        process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'),
        'mcp.json',
      ),
      join(cwd, '.pi', 'mcp.json'),
    ];
    const configs = await Promise.all(
      files.map(async (path) => {
        try {
          const parsed = JSON.parse(await readFile(path, 'utf8')) as {
            mcpServers?: Record<string, ServerConfig>;
          };
          return parsed.mcpServers ?? {};
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
          throw error;
        }
      }),
    );
    const servers = Object.entries({ ...configs[0], ...configs[1] });
    const statuses: PiMcpStatus[] = [];
    // Keep the aggregate startup budget below Pi's readiness deadline even with
    // hundreds of configured servers; workers never exceed four connections.
    const deadline = new AbortController();
    const timer = setTimeout(
      () =>
        deadline.abort(
          new Error('MCP discovery timed out. Reload tools to retry.'),
        ),
      8_000,
    );
    const signal = AbortSignal.any([this.controller.signal, deadline.signal]);
    let index = 0;
    const worker = async () => {
      while (index < servers.length && !this.controller.signal.aborted) {
        const [name, config] = servers[index++];
        if (name === 'elevenex') continue;
        if (
          !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(name) ||
          !config ||
          typeof config !== 'object'
        ) {
          statuses.push({
            name,
            status: 'failed',
            tools: [],
            error: 'Invalid server configuration.',
          });
          continue;
        }
        if (config.enabled === false) {
          statuses.push({ name, status: 'disabled', tools: [] });
          continue;
        }
        const client = new Client({
          name: 'elevenex-pi-mcp',
          version: '1.0.0',
        });
        this.clients.add(client);
        try {
          signal.throwIfAborted();
          const transport = config.url
            ? config.type === 'sse'
              ? new SSEClientTransport(new URL(config.url), {
                  requestInit: { headers: config.headers },
                })
              : new StreamableHTTPClientTransport(new URL(config.url), {
                  requestInit: { headers: config.headers },
                })
            : new StdioClientTransport({
                command: config.command!,
                args: config.args,
                env: config.env,
                cwd,
                stderr: 'pipe',
              });
          if (transport instanceof StdioClientTransport)
            transport.stderr?.on('data', () => undefined);
          const tools = await discoverBeforeAbort(signal, async () => {
            await client.connect(transport, { signal, timeout: 6_000 });
            signal.throwIfAborted();
            const discovered = [];
            let cursor: string | undefined;
            const cursors = new Set<string>();
            do {
              const page = await client.listTools(cursor ? { cursor } : {}, {
                signal,
                timeout: 6_000,
              });
              signal.throwIfAborted();
              discovered.push(...page.tools);
              cursor = page.nextCursor;
              if (cursor && cursors.has(cursor))
                throw new Error('Server returned a repeated tools cursor.');
              if (cursor) cursors.add(cursor);
            } while (cursor);
            return discovered;
          });
          signal.throwIfAborted();
          const safeName = (value: string) =>
            value.replace(
              /[^a-zA-Z0-9-]/g,
              (character) => `_${character.codePointAt(0)!.toString(16)}_`,
            );
          const serverName = safeName(name);
          const registered = tools.map((tool) => {
            // Escape punctuation bijectively for providers that restrict tool names.
            const fullName = `mcp__${serverName}__${safeName(tool.name)}`;
            const toolName =
              fullName.length <= 64
                ? fullName
                : `mcp__${serverName.slice(0, 16)}__${safeName(tool.name).slice(0, 16)}_${createHash('sha256').update(`${name}\0${tool.name}`).digest('hex').slice(0, 16)}`;
            register({
              name: toolName,
              label: tool.title ?? tool.name,
              description: tool.description ?? tool.name,
              parameters: tool.inputSchema,
              execute: async (_id, args, abort) => {
                const result = await client.callTool(
                  { name: tool.name, arguments: args },
                  undefined,
                  { signal: abort, timeout: 660_000 },
                );
                if (result.isError)
                  throw new Error(JSON.stringify(result.content));
                return {
                  content: result.content,
                  details: result.structuredContent,
                };
              },
            });
            return { name: toolName, displayName: tool.title ?? tool.name };
          });
          const status: PiMcpStatus = {
            name,
            status: 'connected',
            tools: registered,
          };
          statuses.push(status);
          client.onclose = () => {
            if (this.controller.signal.aborted) return;
            this.clients.delete(client);
            status.status = 'failed';
            status.tools = [];
            status.error =
              'Connection closed. Reload tools when the agent is idle to reconnect.';
            onStatusChange?.(statuses);
          };
        } catch (error) {
          // Stdio cleanup can take several seconds. Start it immediately without
          // extending Pi's readiness budget; the SDK still terminates the child.
          void client.close().catch(() => undefined);
          this.clients.delete(client);
          statuses.push({
            name,
            status:
              error instanceof UnauthorizedError ? 'needs-auth' : 'failed',
            tools: [],
            error:
              error instanceof UnauthorizedError
                ? 'This server requires credentials. Add its authentication headers in Edit.'
                : error instanceof Error
                  ? error.message
                  : 'Connection failed.',
          });
        }
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(4, servers.length) }, worker),
      );
    } finally {
      clearTimeout(timer);
    }
    // A server may close while another worker is still discovering tools. Do
    // not reactivate its stale registrations when Pi consumes the final result.
    return {
      names: statuses
        .filter((server) => server.status === 'connected')
        .flatMap((server) => server.tools.map((tool) => tool.name)),
      statuses,
    };
  }

  async close(): Promise<void> {
    this.controller.abort();
    const clients = [...this.clients];
    this.clients.clear();
    await Promise.all(
      clients.map((client) => client.close().catch(() => undefined)),
    );
  }
}
