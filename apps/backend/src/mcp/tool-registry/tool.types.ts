import type { z } from 'zod';
import type { McpToolServices } from './mcp-tool-services.js';
import type { DeltaCursorStore } from './delta-cursor.store.js';
import type { DeepLinkBuilder } from '../deep-link/deep-link.builder.js';
import type { HumanChannel } from '../human-channel/human-channel.js';

/**
 * Cost class drives the registry guards and tells the model how expensive a
 * call is so it can budget round-trips:
 *  - `instant`  ⚡ pure DB read (paginate + require scope).
 *  - `cached`   🟢 fast, reuses a backend cache (git-status / branch / change-review).
 *  - `scoped`   🟡 search that must be bounded (require a query + cap results).
 *  - `heavy`    🔴 launches real work — must return a handle to poll, never block.
 */
export type CostClass = 'instant' | 'cached' | 'scoped' | 'heavy';

/**
 * Structured, self-correcting error. Throw this from a tool handler; the
 * registry serialises it as an `isError` result the model can act on.
 */
export class ToolError extends Error {
  readonly code: string;
  readonly remediation?: string;
  readonly retryable: boolean;

  constructor(args: {
    code: string;
    message: string;
    remediation?: string;
    retryable?: boolean;
  }) {
    super(args.message);
    this.name = 'ToolError';
    this.code = args.code;
    this.remediation = args.remediation;
    this.retryable = args.retryable ?? false;
  }
}

/**
 * Every tool returns this shape. The registry flattens it into terse JSON for
 * the model: only `data` plus the optional pointers the agent acts on.
 *  - `data`     the pre-shaped, model-facing payload (no DB noise).
 *  - `touched`  ids/handles a mutating tool created or changed.
 *  - `deepLink` a ready-to-open elevenex URL for the thing it touched/returned.
 *  - `nextStep` the idiomatic follow-up tool/call so the agent composes correctly.
 *  - `truncated`set when output was capped; pair with a "narrow your scope" hint.
 */
export interface ToolResultEnvelope<TData = unknown> {
  data: TData;
  touched?: Record<string, unknown>;
  deepLink?: string;
  nextStep?: string;
  truncated?: boolean;
}

/**
 * Capabilities for the calling connection, derived from its bearer token.
 * Agent sessions get everything; anonymous external clients get reads and
 * non-destructive mutations (destructive ops and the human channel degrade).
 */
export interface ConnectionCaps {
  /** True when the bearer token resolved to a live agent session. */
  isAgent: boolean;
  /** May call mutating (non-destructive) tools. */
  canMutate: boolean;
  /** May call destructive tools (steal/reset/delete/force). */
  canDestroy: boolean;
  /** May reach the human via notify/show/approval/escalation. */
  canUseHumanChannel: boolean;
}

/**
 * Per-call context handed to every tool handler. Assembled by the registry
 * from the MCP request `extra` plus the connection registry.
 */
export interface ToolContext {
  /** Injected domain services (the reused NestJS providers). */
  services: McpToolServices;
  /** Resolved agent session id, or null for anonymous/tokenless callers. */
  agentSessionId: number | null;
  /** What this connection is allowed to do. */
  caps: ConnectionCaps;
  /** Per-connection read_session delta cursors. */
  cursors: DeltaCursorStore;
  /** URL builder for `deepLink`s. */
  deepLink: DeepLinkBuilder;
  /** Notify/show/approval/elicitation sink for this call. */
  human: HumanChannel;
  /** Aborts when the client cancels the request. */
  signal: AbortSignal;
  /** The Mcp-Session-Id of the calling connection (cursor/log scoping). */
  mcpSessionId: string | undefined;
}

type InferShape<Shape extends z.ZodRawShape> = z.infer<z.ZodObject<Shape>>;

/**
 * A single accountable primitive. Granular, never a bundled workflow — the
 * agent composes these. The registry uses the metadata flags to enforce the
 * cross-cutting guarantees (caps gating, pagination caps, empty-query rejection)
 * so individual tools can't regress them.
 */
export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  /** snake_case name; exposed as `mcp__elevenex__<name>`. */
  name: string;
  /** Short human title for clients that render one. */
  title?: string;
  /**
   * Model-facing description: one tight sentence on what it does + when to
   * reach for it, the cost class, and an explicit use-instead / next-tool
   * pointer so the agent chains primitives correctly.
   */
  description: string;
  costClass: CostClass;
  /** Zod raw shape; each field MUST carry a `.describe()` (units, defaults, caps). */
  inputShape: Shape;
  /** MCP behaviour hints surfaced to clients. */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** Requires a live agent session (human-channel tools). */
  requiresAgent?: boolean;
  /** Mutates state — gated on `caps.canMutate`. */
  mutates?: boolean;
  /** Destructive — gated on `caps.canDestroy`. */
  destructive?: boolean;
  /**
   * The tool exposes a `limit` field; the registry caps it. Defaults belong on
   * the zod field via `.default()`.
   */
  paginated?: boolean;
  /**
   * The tool exposes a `query` field; the registry rejects empty / `.` / `*`
   * pathological searches before the handler runs.
   */
  requiresQuery?: boolean;
  handler: (
    args: InferShape<Shape>,
    ctx: ToolContext,
  ) => Promise<ToolResultEnvelope>;
}

/** Identity helper that preserves zod shape inference for handler args. */
export function defineTool<Shape extends z.ZodRawShape>(
  def: ToolDefinition<Shape>,
): ToolDefinition<Shape> {
  return def;
}
