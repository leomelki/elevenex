import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpToolServices } from './mcp-tool-services.js';
import { DeltaCursorStore } from './delta-cursor.store.js';
import { DeepLinkBuilder } from '../deep-link/deep-link.builder.js';
import { AgentHumanChannelService } from '../human-channel/human-channel.js';
import { McpAgentTokenService } from '../identity/mcp-agent-token.service.js';
import { McpConnectionRegistryService } from '../connection/mcp-connection-registry.service.js';
import {
  ToolError,
  type ToolContext,
  type ToolDefinition,
} from './tool.types.js';
import { envelopeToResult, errorToResult } from './result-envelope.js';
import { ALL_TOOLS } from '../tools/index.js';
import { NavigationEventsService } from '../../navigation/navigation-events.service.js';
import { normalizeAutonomyMode } from '../../elevenex-agent/meta-agent-prompt.js';
import {
  isDestructiveElevenexTool,
  ELEVENEX_MCP_TOOL_PREFIX,
  CANCEL_FINISH_TASK_TOOL,
} from '../agent-tool-policy.js';

/** Hard ceiling the wrapper enforces on any `limit` field, regardless of tool. */
const MAX_LIMIT = 100;
/** Search queries that are too broad to be useful and are rejected outright. */
const PATHOLOGICAL_QUERIES = new Set(['', '.', '*', '**', './', '.*', '/']);

interface McpRequestContext {
  authInfo?: { token?: string };
  sessionId?: string;
  signal: AbortSignal;
}

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
    private readonly navEvents: NavigationEventsService,
  ) {}

  /** Register all known tools on a freshly created server. */
  registerAll(server: McpServer): void {
    for (const tool of ALL_TOOLS) {
      this.registerOne(server, tool);
    }
    this.logger.log(`Registered ${ALL_TOOLS.length} elevenex MCP tools`);
  }

  private registerOne(server: McpServer, tool: ToolDefinition): void {
    const handler = async (
      args: Record<string, unknown>,
      extra: McpRequestContext,
    ): Promise<CallToolResult> => {
      try {
        const ctx = await this.buildContext(extra);
        this.enforceCaps(tool, ctx);
        args = await this.applyCurrentSessionScope(tool, args, ctx);
        this.enforceGuards(tool, args);
        await this.enforceSelfTarget(tool, args, ctx);
        await this.enforceMissionAutonomy(tool, args, ctx);
        ctx.signal.throwIfAborted();
        // Approval can leave a call pending while the caller is moved to another
        // folder. Recheck containment immediately before executing side effects.
        await this.enforceSelfTarget(tool, args, ctx);
        const env = await tool.handler(args, ctx);
        if (tool.mutates || tool.destructive) {
          this.navEvents.invalidate();
        }
        return envelopeToResult(env);
      } catch (err) {
        if (extra.signal.aborted)
          return errorToResult(
            new ToolError({
              code: 'cancelled',
              message: 'The tool request was cancelled.',
              remediation:
                'Inspect the target state before retrying; already accepted work may continue.',
            }),
          );
        if (!(err instanceof ToolError) && !(err instanceof HttpException)) {
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
      description:
        tool.description +
        (tool.currentSessionScope
          ? ' Scope defaults to the caller; missions/external clients must specify it.'
          : ''),
      // The SDK validates this shape before invoking the wrapper. Caller
      // defaults are resolved afterwards, preserving typed explicit targets.
      inputSchema: this.inputShape(tool),
      annotations: {
        title: tool.title ?? tool.name,
        readOnlyHint:
          tool.annotations?.readOnlyHint ??
          (!tool.mutates && !tool.destructive),
        destructiveHint:
          tool.destructive === true ||
          isDestructiveElevenexTool(
            `${ELEVENEX_MCP_TOOL_PREFIX}${tool.name}`,
          ) ||
          tool.annotations?.destructiveHint === true,
        idempotentHint: tool.annotations?.idempotentHint,
        openWorldHint: tool.annotations?.openWorldHint,
      },
    };

    server.registerTool(tool.name, config, handler);
  }

  private scopeField(
    tool: ToolDefinition,
  ): 'sessionId' | 'projectId' | 'repoId' | 'taskId' | undefined {
    switch (tool.currentSessionScope) {
      case 'session':
      case 'worktree':
        return 'sessionId';
      case 'project':
        return 'projectId';
      case 'repo':
        return 'repoId';
      case 'task':
        return 'taskId';
      default:
        return undefined;
    }
  }

  private inputShape(tool: ToolDefinition) {
    const field = this.scopeField(tool);
    if (!field) return tool.inputShape;
    const schema = tool.inputShape[field];
    return {
      ...tool.inputShape,
      [field]: schema
        .optional()
        .describe(
          `${schema.description ?? field} Omit for the caller’s ${tool.currentSessionScope}.`,
        ),
    };
  }

  private async applyCurrentSessionScope(
    tool: ToolDefinition,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<Record<string, unknown>> {
    const field = this.scopeField(tool);
    if (!field || args[field] !== undefined) return args;
    // An explicit alternate scope always wins, even if it differs from the caller.
    if (
      tool.currentSessionScope === 'worktree' &&
      (args.worktreePath !== undefined || args.repoId !== undefined)
    )
      return args;
    if (
      tool.currentSessionScope === 'repo' &&
      (args.projectId !== undefined || args.taskId !== undefined)
    )
      return args;
    if (ctx.agentSessionId !== null) {
      const session = await this.services.sessions.findOne(ctx.agentSessionId);
      // Conversation forks/review chats inherit the same task context. Only
      // orchestration missions must avoid defaulting to their hidden workspace.
      if (session.surface !== 'agent') {
        if (field === 'taskId' && session.workspaceId == null) {
          throw new ToolError({
            code: 'no_current_task',
            message: 'This session has no task. Pass an explicit taskId.',
            remediation: 'Use list_tasks or create_task to find a task.',
          });
        }
        return {
          ...args,
          [field]:
            field === 'sessionId'
              ? session.id
              : field === 'taskId'
                ? session.workspaceId
                : session[field],
        };
      }
    }
    // Optional alternative scopes are checked by the handler. Required scopes
    // were made optional for authenticated coding callers, so fail clearly here.
    if (!tool.inputShape[field].isOptional()) {
      throw new ToolError({
        code: 'scope_required',
        message: `${tool.name} requires ${field} outside a coding session.`,
        remediation:
          'Pass an explicit target from get_current_session, find_sessions, or project_overview.',
      });
    }
    return args;
  }

  private async enforceSelfTarget(
    tool: ToolDefinition,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) {
    if (!tool.disallowSelfTarget || ctx.agentSessionId === null) return;
    const scope = tool.disallowSelfTarget;
    const caller =
      scope === 'session'
        ? null
        : await this.services.sessions.findOne(ctx.agentSessionId);
    const self =
      scope === 'session'
        ? args.sessionId === ctx.agentSessionId
        : scope === 'task'
          ? args.taskId === caller!.workspaceId
          : scope === 'folder'
            ? args.folderId === caller!.folderId
            : scope === 'repo'
              ? args.repoId === caller!.repoId
              : args.projectId === caller!.projectId;
    if (self)
      throw new ToolError({
        code: 'self_target_not_allowed',
        message: `${tool.name} cannot target the calling session or stop its task.`,
        remediation:
          'Continue work in this turn. Ask the human to finish or stop this task from Elevenex, or use a separate orchestration session.',
      });
  }

  /** Claude gates these calls in its SDK hook; other mission providers gate at the server. */
  private async enforceMissionAutonomy(
    tool: ToolDefinition,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<void> {
    // Cancellation only withdraws the authenticated caller's pending finish;
    // it must remain available if the mission changes to plan autonomy.
    if (`${ELEVENEX_MCP_TOOL_PREFIX}${tool.name}` === CANCEL_FINISH_TASK_TOOL)
      return;
    const risky =
      tool.destructive ||
      isDestructiveElevenexTool(`${ELEVENEX_MCP_TOOL_PREFIX}${tool.name}`);
    if (ctx.agentSessionId == null || (!risky && !tool.mutates)) return;
    const session = await this.services.sessions.findOne(ctx.agentSessionId);
    if (session.surface !== 'agent' || session.activeAgentProvider === 'claude')
      return;
    const mode = normalizeAutonomyMode(session.agentAutonomyMode);
    if (mode === 'full' || (mode === 'review' && !risky)) return;
    ctx.signal.throwIfAborted();
    const approval = await ctx.human.requestApproval({
      title: `Allow ${tool.title ?? tool.name}?`,
      detail: JSON.stringify(args),
      deepLink: `/sessions/${session.id}`,
    });
    ctx.signal.throwIfAborted();
    if (approval.decision !== 'approve') {
      throw new ToolError({
        code: 'approval_denied',
        message: `The human did not approve ${tool.name}.`,
        remediation: 'Respect this decision and choose another approach.',
      });
    }
  }

  /** Assemble the per-call context from the MCP request `extra`. */
  private async buildContext(extra: McpRequestContext): Promise<ToolContext> {
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
        message: `${tool.name} requires an authenticated Elevenex session.`,
        remediation:
          'Run from an Elevenex coding session or mission using its MCP bearer token. Anonymous external clients cannot use this tool.',
      });
    }
    if (
      (tool.destructive ||
        isDestructiveElevenexTool(`${ELEVENEX_MCP_TOOL_PREFIX}${tool.name}`)) &&
      !ctx.caps.canDestroy
    ) {
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
