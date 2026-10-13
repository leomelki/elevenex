import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../../database/database.provider.js';
import * as schema from '../../database/schema/index.js';

/**
 * Leaf service that maps a coding-session or mission bearer token to its session id
 * and back. Lives on its own (no domain-service deps) so it can be injected by
 * both the MCP module (to resolve incoming tokens) and the agent-session
 * creation path (to mint) without forming an `ElevenexAgentModule ↔ McpModule`
 * dependency cycle.
 *
 * The token is stored on `sessions.mcpAgentToken`; resolution is a single
 * DB lookup, with a token-to-id cache for primary-key checks on the hot path.
 * Tokens are checked against persisted sessions on every call so
 * deleted sessions cannot retain access through a stale cache.
 */
@Injectable()
export class McpAgentTokenService {
  private readonly cache = new Map<string, number>();
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /**
   * Mint (or reuse) the token for a session. Idempotent: re-minting for
   * a session that already has a token returns the existing one so resumed
   * resumed runtimes keep a stable `ELEVENEX_AGENT_TOKEN`.
   */
  async ensureToken(sessionId: number): Promise<string> {
    const existing = await this.db
      .select({ token: schema.sessions.mcpAgentToken })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .limit(1);
    if (!existing.length) throw new Error(`Session ${sessionId} not found.`);
    const current = existing[0].token;
    if (current) {
      this.cache.set(current, sessionId);
      return current;
    }
    const token = `evx_${randomBytes(24).toString('base64url')}`;
    const minted = await this.db
      .update(schema.sessions)
      .set({ mcpAgentToken: token })
      .where(
        and(
          eq(schema.sessions.id, sessionId),
          isNull(schema.sessions.mcpAgentToken),
        ),
      )
      .returning({ token: schema.sessions.mcpAgentToken });
    // Multiple providers can initialize a session concurrently. Keep the first
    // token rather than invalidating a runtime that already connected with it.
    const stored = minted[0]?.token ?? (await this.getToken(sessionId));
    if (!stored) throw new Error(`Session ${sessionId} no longer exists.`);
    this.cache.set(stored, sessionId);
    return stored;
  }

  /** Read the token currently stored for a session, if any. */
  async getToken(sessionId: number): Promise<string | null> {
    const rows = await this.db
      .select({ token: schema.sessions.mcpAgentToken })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .limit(1);
    return rows[0]?.token ?? null;
  }

  /**
   * Resolve an incoming bearer token to its agent session id, or null if the
   * token is unknown (anonymous external client).
   */
  async resolveSessionId(token: string | undefined): Promise<number | null> {
    if (!token) return null;
    const cached = this.cache.get(token);
    if (cached !== undefined) {
      if ((await this.getToken(cached)) === token) return cached;
      this.cache.delete(token);
      return null;
    }
    const rows = await this.db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.mcpAgentToken, token))
      .limit(1);
    const sessionId = rows[0]?.id ?? null;
    if (sessionId !== null) this.cache.set(token, sessionId);
    return sessionId;
  }
}
