import { Injectable, Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpToolServices } from './mcp-tool-services.js';
import { DeltaCursorStore } from './delta-cursor.store.js';
import { DeepLinkBuilder } from '../deep-link/deep-link.builder.js';
import { AgentHumanChannelService } from '../human-channel/human-channel.js';
import { McpAgentTokenService } from '../identity/mcp-agent-token.service.js';
import { McpConnectionRegistryService } from '../connection/mcp-connection-registry.service.js';
import { ToolError, type ToolContext, type ToolDefinition } from './tool.types.js';
import { envelopeToResult, errorToResult } from './result-envelope.js';
import { ALL_TOOLS } from '../tools/index.js';

/** Hard ceiling the wrapper enforces on any `limit` field, regardless of tool. */
const MAX_LIMIT = 100;
/** Search queries that are too broad to be useful and are rejected outright. */
const PATHOLOGICAL_QUERIES = new Set(['', '.', '*', '**', './', '.*', '/']);

/**
 * Registers every `ToolDefinition` on an `McpServer` and owns the mechanical
 * cross-cutting guarantees so individual tools can't regress them:
 *  - capability gating (agent-only / mutate / destructive),
 *  - pagination caps and empty/pathological-query rejection,
 *  - per-call `ToolContext` assembly (identity, caps, cursors, human channel),
 *  - terse-envelope + structured-error result shaping.
 */
@Injectable()
export class ToolRegistryService {
  private readonly logger = new Logger(ToolRegistryService.name);

  constructor(
    private readonly services: McpToolServices,
    private readonly cursors: DeltaCursorStore,
    private readonly deepLink: DeepLinkBuilder,
    private readonly human: AgentHumanChannelService,
    private readonly tokens: McpAgentTokenService,
    private readonly connections: McpConnectionRegistryService,
  ) {}

  /** Register all known tools on a freshly created server. */
  registerAll(server: McpServer): void {
    for (const tool of ALL_TOOLS) {
      this.registerOne(server, tool);
    }
    this.logger.log(`Registered ${ALL_TOOLS.length} elevenex MCP tools`);
  }

  private registerOne(server: McpServer, tool: ToolDefinition): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = async (args: any, extra: any): Promise<CallToolResult> => {
      try {
        const ctx = await this.buildContext(extra);
        this.enforceCaps(tool, ctx);
        this.enforceGuards(tool, args);
        const env = await tool.handler(args, ctx);
        return envelopeToResult(env);
      } catch (err) {
        if (!(err instanceof ToolError)) {
          this.logger.error(
            `Tool ${tool.name} failed: ${
              err instanceof Error ? err.stack : String(err)
            }`,
          );
        }
        return errorToResult(err);
      }
    };

    const config = {
      title: tool.title ?? tool.name,
      description: tool.description,
      // Cross-zod-version friction (SDK ships its own zod compat layer): the
      // raw shape is validated at runtime by the SDK; the cast keeps the dual
      // zod major versions from clashing at compile time.
      inputSchema: tool.inputShape,
      annotations: {
        title: tool.title ?? tool.name,
        readOnlyHint:
          tool.annotations?.readOnlyHint ?? (!tool.mutates && !tool.destructive),
        destructiveHint:
          tool.annotations?.destructiveHint ?? tool.destructive ?? false,
        idempotentHint: tool.annotations?.idempotentHint,
        openWorldHint: tool.annotations?.openWorldHint,
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server.registerTool as any)(tool.name, config, handler);
  }

  /** Assemble the per-call context from the MCP request `extra`. */
  private async buildContext(extra: {
    authInfo?: { token?: string };
    sessionId?: string;
    signal: AbortSignal;
  }): Promise<ToolContext> {
    const token = extra.authInfo?.token;
    const agentSessionId = await this.tokens.resolveSessionId(token);
    const caps = McpConnectionRegistryService.capsFor(agentSessionId);
    // Keep the connection registry current for human-channel routing/presence.
    if (extra.sessionId) {
      this.connections.register(extra.sessionId, agentSessionId);
    }
    return {
      services: this.services,
      agentSessionId,
      caps,
      cursors: this.cursors,
      deepLink: this.deepLink,
      human: this.human.bindFor({
        agentSessionId,
        canUseHumanChannel: caps.canUseHumanChannel,
      }),
      signal: extra.signal,
      mcpSessionId: extra.sessionId,
    };
  }

  private enforceCaps(tool: ToolDefinition, ctx: ToolContext): void {
    if (tool.requiresAgent && !ctx.caps.isAgent) {
      throw new ToolError({
        code: 'requires_agent_session',
        message: `${tool.name} requires a live agent session.`,
        remediation:
          'Run from an agent session (with ELEVENEX_AGENT_TOKEN). Anonymous external clients cannot use this tool.',
      });
    }
    if (tool.destructive && !ctx.caps.canDestroy) {
      throw new ToolError({
        code: 'destructive_not_allowed',
        message: `${tool.name} is destructive and is not allowed for this connection.`,
        remediation:
          'Destructive operations require an agent session; escalate to the human or run with an agent token.',
      });
    }
    if (tool.mutates && !ctx.caps.canMutate) {
      throw new ToolError({
        code: 'mutation_not_allowed',
        message: `${tool.name} mutates state and is not allowed for this connection.`,
      });
    }
  }

  private enforceGuards(
    tool: ToolDefinition,
    args: Record<string, unknown>,
  ): void {
    if (tool.paginated && typeof args.limit === 'number') {
      args.limit = Math.min(Math.max(1, Math.floor(args.limit)), MAX_LIMIT);
    }
    if (tool.requiresQuery) {
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      if (PATHOLOGICAL_QUERIES.has(q)) {
        throw new ToolError({
          code: 'empty_query',
          message: `${tool.name} requires a specific, non-trivial query.`,
          remediation:
            'Pass a concrete search term (an identifier, phrase, or path fragment) — broad wildcards are rejected to protect cost and latency.',
        });
      }
    }
  }
}
