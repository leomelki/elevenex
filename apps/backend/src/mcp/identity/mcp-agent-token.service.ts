import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../../database/database.provider.js';
import * as schema from '../../database/schema/index.js';

/**
 * Leaf service that maps the per-agent-session bearer token to its session id
 * and back. Lives on its own (no domain-service deps) so it can be injected by
 * both the MCP module (to resolve incoming tokens) and the agent-session
 * creation path (to mint) without forming an `ElevenexAgentModule ↔ McpModule`
 * dependency cycle.
 *
 * The token is stored on `sessions.mcpAgentToken`; resolution is a single
 * indexed-ish lookup, cached in-memory for the hot read path.
 */
@Injectable()
export class McpAgentTokenService {
  /** token -> sessionId, populated lazily and on mint. */
  private readonly cache = new Map<string, number>();

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /**
   * Mint (or reuse) the token for an agent session. Idempotent: re-minting for
   * a session that already has a token returns the existing one so resumed
   * missions keep a stable `ELEVENEX_AGENT_TOKEN`.
   */
  async ensureToken(sessionId: number): Promise<string> {
    const existing = await this.db
      .select({ token: schema.sessions.mcpAgentToken })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .limit(1);
    const current = existing[0]?.token ?? null;
    if (current) {
      this.cache.set(current, sessionId);
      return current;
    }
    const token = `evx_${randomBytes(24).toString('base64url')}`;
    await this.db
      .update(schema.sessions)
      .set({ mcpAgentToken: token })
      .where(eq(schema.sessions.id, sessionId));
    this.cache.set(token, sessionId);
    return token;
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
    if (cached !== undefined) return cached;
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
