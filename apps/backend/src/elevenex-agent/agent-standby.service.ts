import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ClaudeRuntimeService } from '../claude-runtime/claude-runtime.service.js';
import { McpAgentTokenService } from '../mcp/identity/mcp-agent-token.service.js';
import {
  DEFAULT_AGENT_AUTONOMY_MODE,
  SessionsService,
  type AgentAutonomyMode,
} from '../sessions/sessions.service.js';
import { ElevenexAgentService } from './elevenex-agent.service.js';
import { normalizeAutonomyMode } from './meta-agent-prompt.js';

/** Sentinel name used for pre-warmed standby sessions so they are filtered
 *  out of the mission list and cleaned up on restart. */
export const STANDBY_SESSION_NAME = '__standby__';

/**
 * Keeps one warm agent session ready at all times so that launching a mission
 * hits an already-running Claude Code process instead of cold-starting one.
 *
 * Lifecycle:
 *  1. On module init: archive orphaned standbys from previous runs, then
 *     start warming a standby for the default autonomy mode.
 *  2. When `createMission` calls `claimStandby(mode)`: if a warm standby
 *     with a matching mode exists, return its session ID immediately and
 *     schedule the next warm standby.
 *  3. The caller should pass the last-used autonomy mode to `scheduleStandby`
 *     so the replacement matches the user's typical workflow.
 */
@Injectable()
export class AgentStandbyService implements OnModuleInit {
  private readonly logger = new Logger(AgentStandbyService.name);

  private standbySessionId: number | null = null;
  private standbyMode: AgentAutonomyMode | null = null;
  /** Guards against concurrent warmup attempts. */
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly agentService: ElevenexAgentService,
    private readonly sessionsService: SessionsService,
    private readonly tokenService: McpAgentTokenService,
    private readonly claudeRuntime: ClaudeRuntimeService,
  ) {}

  async onModuleInit(): Promise<void> {
    void this.cleanOrphanedStandbys();
    this.scheduleStandby(DEFAULT_AGENT_AUTONOMY_MODE);
  }

  /**
   * Claim the warm standby if one is ready and its autonomy mode matches.
   * Returns the session ID (ready to have `submitPrompt` called on it) or null
   * when no warm standby is available, in which case the caller falls back to
   * a cold start.
   */
  claimStandby(mode: AgentAutonomyMode): number | null {
    const id = this.standbySessionId;
    if (id == null || this.standbyMode !== mode) {
      return null;
    }
    // The idle-shutdown timer may have closed the process while it sat unused.
    if (!this.claudeRuntime.isSessionWarm(id)) {
      this.logger.debug(`Standby session=${id} expired before claim, discarding`);
      this.standbySessionId = null;
      this.standbyMode = null;
      return null;
    }
    this.standbySessionId = null;
    this.standbyMode = null;
    this.logger.log(`Standby claimed session=${id} mode=${mode}`);
    return id;
  }

  /**
   * Fire-and-forget: begin warming a replacement standby for the given mode.
   * De-duplicated — a second call while one is in flight is a no-op.
   */
  scheduleStandby(mode: AgentAutonomyMode): void {
    if (this.inFlight) {
      return;
    }
    this.inFlight = this.createStandby(normalizeAutonomyMode(mode))
      .catch((err: unknown) => {
        this.logger.warn(`Standby warmup failed: ${String(err)}`);
      })
      .finally(() => {
        this.inFlight = null;
      });
  }

  private async createStandby(mode: AgentAutonomyMode): Promise<void> {
    const { repoId, worktreePath } = await this.agentService.ensureAgentRepo();

    const session = await this.sessionsService.create({
      repoId,
      worktreePath,
      branchName: 'main',
      surface: 'agent',
      activeAgentProvider: 'claude',
      name: STANDBY_SESSION_NAME,
    });
    const sessionId = session.id;

    // Wire up identity and autonomy before the prewarm starts the process, so
    // the runtime is built with the correct permission mode and system prompt.
    await this.tokenService.ensureToken(sessionId);
    await this.sessionsService.updateAgentAutonomyMode(sessionId, mode);
    await this.claudeRuntime.setAgentAutonomy(sessionId, mode);

    // Start the Claude Code process and wait until it signals ready. After this
    // returns the process is warm and will accept a first turn with no delay.
    await this.claudeRuntime.prewarmSession(sessionId);

    this.standbySessionId = sessionId;
    this.standbyMode = mode;
    this.logger.log(`Standby ready session=${sessionId} mode=${mode}`);
  }

  /** Archive `__standby__` rows left over from a previous server run. */
  private async cleanOrphanedStandbys(): Promise<void> {
    try {
      const sessions = await this.sessionsService.findBySurface('agent');
      const orphans = sessions.filter(
        (s) => s.name === STANDBY_SESSION_NAME && s.status !== 'archived',
      );
      await Promise.all(orphans.map((s) => this.sessionsService.archiveAndStop(s.id)));
      if (orphans.length > 0) {
        this.logger.log(`Archived ${orphans.length} orphaned standby session(s)`);
      }
    } catch (err: unknown) {
      this.logger.warn(`Standby cleanup failed: ${String(err)}`);
    }
  }
}
