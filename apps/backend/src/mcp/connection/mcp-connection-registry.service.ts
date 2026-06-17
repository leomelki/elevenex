import { Injectable } from '@nestjs/common';
import type { ConnectionCaps } from '../tool-registry/tool.types.js';

/**
 * What we record per live MCP connection (one per `Mcp-Session-Id`). The bearer
 * token is resolved once at initialize and reused for every call on the
 * connection so tool handlers don't re-hit the token store.
 */
export interface McpConnection {
  mcpSessionId: string;
  /** Agent session id this connection acts as, or null when anonymous. */
  agentSessionId: number | null;
  caps: ConnectionCaps;
}

/**
 * Maps `Mcp-Session-Id` -> connection identity/caps. Lets human-channel tools
 * route to the right agent session's panel and keeps the door open for
 * presence/observability of connected clients.
 */
@Injectable()
export class McpConnectionRegistryService {
  private readonly connections = new Map<string, McpConnection>();

  /** Derive caps from whether a token resolved to an agent session. */
  static capsFor(agentSessionId: number | null): ConnectionCaps {
    const isAgent = agentSessionId !== null;
    return {
      isAgent,
      // Anonymous external clients may read and make non-destructive changes;
      // destructive ops and the human channel require a real agent session.
      canMutate: true,
      canDestroy: isAgent,
      canUseHumanChannel: isAgent,
    };
  }

  register(mcpSessionId: string, agentSessionId: number | null): McpConnection {
    const connection: McpConnection = {
      mcpSessionId,
      agentSessionId,
      caps: McpConnectionRegistryService.capsFor(agentSessionId),
    };
    this.connections.set(mcpSessionId, connection);
    return connection;
  }

  get(mcpSessionId: string | undefined): McpConnection | undefined {
    if (!mcpSessionId) return undefined;
    return this.connections.get(mcpSessionId);
  }

  remove(mcpSessionId: string): void {
    this.connections.delete(mcpSessionId);
  }

  /** All connections currently acting as the given agent session. */
  findByAgentSession(agentSessionId: number): McpConnection[] {
    return [...this.connections.values()].filter(
      (c) => c.agentSessionId === agentSessionId,
    );
  }
}
