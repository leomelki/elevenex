import { readFile } from 'fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Minimal Pi extension contract, keeping the backend independent of Pi's npm package. */
interface PiExtensionApi {
  on(
    event: string,
    handler: (
      event: unknown,
      ctx: { ui: { setStatus(key: string, text: string): void } },
    ) => Promise<unknown>,
  ): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (
      id: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<unknown>;
  }): void;
  setActiveTools(names: string[]): void;
}

/** Loaded only for Elevenex missions via --extension, never for coding sessions. */
export default function elevenexAgentExtension(pi: PiExtensionApi): void {
  let client: Client | null = null;
  let toolNames: string[] = [];

  pi.registerTool({
    name: 'TodoWrite',
    label: 'Mission plan',
    description:
      'Record the ordered mission plan and update each step as it progresses.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
              },
              activeForm: { type: 'string' },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    execute: async (_id, args) => ({
      content: [{ type: 'text', text: JSON.stringify(args) }],
      details: args,
    }),
  });

  pi.on('session_start', async (_event, ctx) => {
    try {
      client = new Client({ name: 'elevenex-pi-agent', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(process.env.ELEVENEX_MCP_URL!),
          {
            requestInit: {
              headers: {
                Authorization: `Bearer ${process.env.ELEVENEX_AGENT_TOKEN}`,
              },
            },
          },
        ),
      );
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        for (const tool of page.tools) {
          const name = `mcp__elevenex__${tool.name}`;
          toolNames.push(name);
          pi.registerTool({
            name,
            label: tool.title ?? tool.name,
            description: tool.description ?? tool.name,
            parameters: tool.inputSchema,
            execute: async (_id, args, signal) => {
              if (!client)
                throw new Error('Elevenex MCP connection is closed.');
              const result = await client.callTool(
                { name: tool.name, arguments: args },
                undefined,
                { signal, timeout: 660_000 },
              );
              if (result.isError) {
                throw new Error(JSON.stringify(result.content));
              }
              return {
                content: result.content,
                details: result.structuredContent,
              };
            },
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      // Missions operate through Elevenex; built-in shell/edit tools would bypass its mandate.
      pi.setActiveTools(['TodoWrite', ...toolNames]);
      // Pi redirects extension stdout to stderr; status notifications use the real RPC output.
      ctx.ui.setStatus('elevenex_agent_ready', 'ready');
    } catch (error) {
      pi.setActiveTools([]);
      ctx.ui.setStatus('elevenex_agent_ready', `error: ${String(error)}`);
    }
  });

  pi.on('before_agent_start', async () => ({
    systemPrompt: await readFile(process.env.ELEVENEX_AGENT_PROMPT!, 'utf8'),
  }));

  pi.on('session_shutdown', async () => {
    const closing = client;
    client = null;
    toolNames = [];
    await closing?.close();
  });
}
