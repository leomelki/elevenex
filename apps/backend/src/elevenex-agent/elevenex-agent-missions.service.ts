import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ElevenexAgentService } from './elevenex-agent.service.js';
import { AgentStandbyService, STANDBY_SESSION_NAME } from './agent-standby.service.js';
import { McpAgentTokenService } from '../mcp/identity/mcp-agent-token.service.js';
import { ClaudeRuntimeService } from '../claude-runtime/claude-runtime.service.js';
import {
  SessionsService,
  type AgentAutonomyMode,
  DEFAULT_AGENT_AUTONOMY_MODE,
} from '../sessions/sessions.service.js';
import { normalizeAutonomyMode } from './meta-agent-prompt.js';
import { AgentFocusService } from '../agent-focus/agent-focus.service.js';

/** Compact mission summary for the panel's mission list. */
export interface MissionSummary {
  sessionId: number;
  title: string;
  status: string;
  runPhase: string | null;
  awaitingApproval: boolean;
  autonomyMode: AgentAutonomyMode;
  // The hidden agent workspace this mission runs in — the panel needs both to
  // mount the live session view (app-claude-workspace).
  repoId: number;
  worktreePath: string;
  deepLink: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * Thin orchestration over agent (mission) sessions. "A mission IS an agent
 * session": this is the only place that encodes that mapping. It composes
 * existing services — it does not reimplement session lifecycle, identity, or
 * the runtime.
 */
@Injectable()
export class ElevenexAgentMissionsService {
  private readonly logger = new Logger(ElevenexAgentMissionsService.name);

  constructor(
    private readonly agentService: ElevenexAgentService,
    private readonly standby: AgentStandbyService,
    private readonly sessionsService: SessionsService,
    private readonly tokenService: McpAgentTokenService,
    private readonly claudeRuntime: ClaudeRuntimeService,
    private readonly agentFocus: AgentFocusService,
  ) {}

  async createMission(input: {
    prompt: string;
    autonomyMode?: AgentAutonomyMode;
    model?: string | null;
    focusedSessionId?: number | null;
  }): Promise<MissionSummary> {
    const prompt = input.prompt.trim();
    const autonomyMode = normalizeAutonomyMode(
      input.autonomyMode ?? DEFAULT_AGENT_AUTONOMY_MODE,
    );

    // Fast path: claim a pre-warmed standby session. The Claude Code process is
    // already running and will accept the first turn with no startup delay.
    const standbyId = this.standby.claimStandby(autonomyMode);
    let sessionId: number;

    if (standbyId != null) {
      sessionId = standbyId;
      await this.sessionsService.update(sessionId, { name: this.deriveTitle(prompt) });
      if (input.model) {
        await this.claudeRuntime.setSelectedModel(sessionId, input.model);
      }
      await this.sessionsService.start(sessionId);
      this.logger.log(`Mission warm-start session=${sessionId} autonomy=${autonomyMode}`);
    } else {
      // Cold path: create and wire up a fresh session.
      const { repoId, worktreePath } = await this.agentService.ensureAgentRepo();
      const session = await this.sessionsService.create({
        repoId,
        worktreePath,
        branchName: 'main',
        surface: 'agent',
        activeAgentProvider: 'claude',
        name: this.deriveTitle(prompt),
      });
      sessionId = session.id;
      await this.tokenService.ensureToken(sessionId);
      await this.sessionsService.updateAgentAutonomyMode(sessionId, autonomyMode);
      await this.claudeRuntime.setAgentAutonomy(sessionId, autonomyMode);
      if (input.model) {
        await this.claudeRuntime.setSelectedModel(sessionId, input.model);
      }
      await this.sessionsService.start(sessionId);
      this.logger.log(`Mission cold-start session=${sessionId} autonomy=${autonomyMode}`);
    }

    // Record the UI focus the user had when launching this mission so the agent
    // can pull it via get_focused_session (it is NOT injected into the prompt).
    this.agentFocus.record(sessionId, input.focusedSessionId);

    // Submit the prompt. For warm starts the process is already running so this
    // delivers the first turn immediately; for cold starts it is fire-and-forget
    // to avoid blocking the HTTP response on process startup.
    void this.claudeRuntime.submitPrompt(sessionId, prompt).catch((err: unknown) => {
      this.logger.error(
        `Mission prompt submission failed session=${sessionId}: ${String(err)}`,
      );
    });

    // Immediately start warming the next standby for the same mode so the
    // following mission launch is instant too.
    this.standby.scheduleStandby(autonomyMode);

    return this.getMission(sessionId);
  }

  async listMissions(): Promise<MissionSummary[]> {
    const sessions = await this.sessionsService.findBySurface('agent');
    const summaries = await Promise.all(
      sessions
        .filter((s) => s.name !== STANDBY_SESSION_NAME)
        .map((session) => this.toSummary(session)),
    );
    // Newest first.
    return summaries.sort((a, b) =>
      (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
    );
  }

  async getMission(sessionId: number): Promise<MissionSummary> {
    const session = await this.findAgentSession(sessionId);
    return this.toSummary(session);
  }

  async setAutonomy(
    sessionId: number,
    mode: AgentAutonomyMode,
  ): Promise<MissionSummary> {
    await this.findAgentSession(sessionId);
    const normalized = normalizeAutonomyMode(mode);
    await this.sessionsService.updateAgentAutonomyMode(sessionId, normalized);
    await this.claudeRuntime.setAgentAutonomy(sessionId, normalized);
    return this.getMission(sessionId);
  }

  async interruptMission(sessionId: number): Promise<void> {
    await this.findAgentSession(sessionId);
    await this.claudeRuntime.interrupt(sessionId);
  }

  async archiveMission(sessionId: number): Promise<void> {
    await this.findAgentSession(sessionId);
    await this.sessionsService.archiveAndStop(sessionId);
  }

  /** Resolve a session id, guarding that it is an agent (mission) session. */
  private async findAgentSession(sessionId: number) {
    const session = await this.sessionsService.findOne(sessionId);
    if (session.surface !== 'agent') {
      throw new NotFoundException(`No mission with id ${sessionId}.`);
    }
    return session;
  }

  private async toSummary(session: {
    id: number;
    name?: string | null;
    status: string;
    agentAutonomyMode?: string | null;
    repoId: number;
    worktreePath: string;
    createdAt?: string | null;
    updatedAt?: string | null;
  }): Promise<MissionSummary> {
    let runPhase: string | null = null;
    let awaitingApproval = false;
    try {
      const state = await this.claudeRuntime.getRuntimeState(session.id);
      runPhase = state.runPhase ?? null;
      awaitingApproval =
        Boolean(state.pendingPermissionRequest) ||
        Boolean(state.pendingUserInputRequest);
    } catch {
      // No live runtime yet — fall back to the persisted session status.
    }
    return {
      sessionId: session.id,
      title: session.name ?? `Mission ${session.id}`,
      status: session.status,
      runPhase,
      awaitingApproval,
      autonomyMode: normalizeAutonomyMode(session.agentAutonomyMode),
      repoId: session.repoId,
      worktreePath: session.worktreePath,
      deepLink: this.deepLink(session.id),
      createdAt: session.createdAt ?? null,
      updatedAt: session.updatedAt ?? null,
    };
  }

  private deepLink(sessionId: number): string {
    return `/sessions/${sessionId}`;
  }

  /** A short, human-readable mission title from the prompt's first line. */
  private deriveTitle(prompt: string): string {
    const firstLine = prompt.split('\n').find((line) => line.trim()) ?? prompt;
    const trimmed = firstLine.trim().replace(/\s+/g, ' ');
    if (trimmed.length <= 60) {
      return trimmed || 'New mission';
    }
    return `${trimmed.slice(0, 57)}…`;
  }
}
