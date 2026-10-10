import { readFile } from 'fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function responseUsage(message: unknown): PiUsage | null {
  const record = message as { role?: string; usage?: PiUsage } | undefined;
  const usage = record?.usage;
  if (
    record?.role !== 'assistant' ||
    !usage ||
    ![usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(
      (value) => Number.isFinite(value) && value >= 0,
    )
  )
    return null;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
  };
}

interface PiContext {
  ui: { setStatus(key: string, text: string): void };
  model?: { provider: string; id: string };
  sessionManager?: { getBranch(): { type: string; message?: unknown }[] };
  getContextUsage?():
    | { tokens: number | null; contextWindow: number; percent: number | null }
    | undefined;
}

/** Minimal Pi extension contract, keeping the backend independent of Pi's npm package. */
interface PiExtensionApi {
  on(
    event: string,
    handler: (event: unknown, ctx: PiContext) => Promise<unknown>,
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

/** Native context telemetry for every session; mission tools only when explicitly configured. */
export default function elevenexAgentExtension(pi: PiExtensionApi): void {
  let lastSent: string | null = null;
  let lastReadAt = 0;
  let apiUsage: PiUsage | null = null;
  for (const name of [
    'session_start',
    'session_switch',
    'session_compact',
    'model_select',
    'agent_start',
    'turn_start',
    'tool_execution_start',
    'message_start',
    'message_update',
    'message_end',
    'tool_execution_end',
    'agent_end',
  ]) {
    pi.on(name, async (event, ctx) => {
      if (name === 'session_start' || name === 'session_switch') {
        apiUsage = null;
        // Hydrate only from the current branch, stopping at compaction.
        const branch = ctx.sessionManager?.getBranch() ?? [];
        for (let index = branch.length - 1; index >= 0; index--) {
          if (branch[index].type === 'compaction') break;
          apiUsage = responseUsage(branch[index].message);
          if (apiUsage) break;
        }
      } else if (name === 'session_compact' || name === 'model_select') {
        apiUsage = null;
      } else if (name === 'message_end') {
        apiUsage =
          responseUsage((event as { message?: unknown }).message) ?? apiUsage;
      }
      // Stream updates can arrive for each character. Read at most once per
      // 1.5s there; boundaries always publish, including the very first run.
      const now = Date.now();
      if (name === 'message_update' && now - lastReadAt < 1500) return;
      lastReadAt = now;
      const payload = JSON.stringify({
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
        usage: ctx.getContextUsage?.() ?? null,
        apiUsage,
      });
      if (payload === lastSent) return;
      lastSent = payload;
      // RPC forwards status records on stdout (extension stdout itself is redirected).
      ctx.ui.setStatus('elevenex_context_usage', payload);
    });
  }
  if (!process.env.ELEVENEX_AGENT_TOKEN) return;
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
