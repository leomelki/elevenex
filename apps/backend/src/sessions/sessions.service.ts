import {
  Inject,
  Injectable,
  NotFoundException,
  BadRequestException,
  forwardRef,
} from '@nestjs/common';
import { eq, and, count } from 'drizzle-orm';
import { EventEmitter } from 'events';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { PtyManager } from '../terminal/pty-manager.service.js';
import { TmuxManager } from '../terminal/tmux-manager.service.js';
import { AGENT_RUNTIME_CLEANUP_SERVICE } from '../agent-runtime/agent-runtime.tokens.js';
import type { AgentRuntimeCleanup } from '../agent-runtime/agent-runtime.types.js';
import type { AgentProviderId } from '../agent-runtime/agent-runtime.types.js';

const VALID_STATUSES = ['created', 'active', 'archived', 'stopped'] as const;
type SessionStatus = (typeof VALID_STATUSES)[number];
const VALID_COMPLETION_KINDS = ['completed'] as const;
type SessionCompletionKind = (typeof VALID_COMPLETION_KINDS)[number];

@Injectable()
export class SessionsService extends EventEmitter {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(forwardRef(() => PtyManager)) private readonly ptyManager: PtyManager,
    private readonly tmuxManager: TmuxManager,
    @Inject(AGENT_RUNTIME_CLEANUP_SERVICE)
    private readonly agentRuntimeCleanup: AgentRuntimeCleanup,
  ) {
    super();
  }

  async create(dto: {
    repoId: number;
    branchName: string;
    worktreePath: string;
    name?: string;
  }) {
    let sessionName = dto.name;

    // Auto-generate name if not provided
    if (!sessionName) {
      const sessionCount = await this.countByRepoAndBranch(
        dto.repoId,
        dto.branchName,
      );
      sessionName = `Session ${sessionCount + 1}`;
    }

    const rows = await this.db
      .insert(schema.sessions)
      .values({
        repoId: dto.repoId,
        branchName: dto.branchName,
        worktreePath: dto.worktreePath,
        name: sessionName,
        status: 'created',
        activeAgentProvider: 'claude',
        claudeSessionId: '-1',
        codexSessionId: '-1',
        piSessionPath: '-1',
        hasInjectedWorktreeContext: false,
      })
      .returning();

    return this.withInferredActiveAgentProvider(rows[0]);
  }

  async findByRepo(repoId: number) {
    const rows = await this.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.repoId, repoId));
    return rows.map((session) => this.withInferredActiveAgentProvider(session));
  }

  async findAll() {
    const rows = await this.db.select().from(schema.sessions);
    return rows.map((session) => this.withInferredActiveAgentProvider(session));
  }

  async findAllCompletionStates() {
    return this.db
      .select({
        id: schema.sessions.id,
        hasUnreviewedCompletion: schema.sessions.hasUnreviewedCompletion,
        lastCompletionAt: schema.sessions.lastCompletionAt,
        lastCompletionKind: schema.sessions.lastCompletionKind,
        lastStateChangeAt: schema.sessions.lastStateChangeAt,
      })
      .from(schema.sessions);
  }

  async findByWorktreePath(worktreePath: string) {
    const rows = await this.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.worktreePath, worktreePath));
    return rows.map((session) => this.withInferredActiveAgentProvider(session));
  }

  async findByRepoAndBranch(repoId: number, branchName: string) {
    const rows = await this.db
      .select()
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.repoId, repoId),
          eq(schema.sessions.branchName, branchName),
        ),
      );
    return rows.map((session) => this.withInferredActiveAgentProvider(session));
  }

  async findByRepoAndWorktreePath(repoId: number, worktreePath: string) {
    const rows = await this.db
      .select()
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.repoId, repoId),
          eq(schema.sessions.worktreePath, worktreePath),
        ),
      );
    return rows.map((session) => this.withInferredActiveAgentProvider(session));
  }

  async findOne(id: number) {
    const rows = await this.db
      .select({
        session: schema.sessions,
        projectId: schema.repos.projectId,
        repoColor: schema.repos.color,
      })
      .from(schema.sessions)
      .innerJoin(schema.repos, eq(schema.sessions.repoId, schema.repos.id))
      .where(eq(schema.sessions.id, id));

    if (rows.length === 0) {
      throw new NotFoundException(`Session with id ${id} not found`);
    }

    const { session, projectId, repoColor } = rows[0];
    return this.withInferredActiveAgentProvider({ ...session, projectId, repoColor });
  }

  async update(id: number, data: { name?: string }) {
    const rows = await this.db
      .update(schema.sessions)
      .set({
        ...data,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.sessions.id, id))
      .returning();

    if (rows.length === 0) {
      throw new NotFoundException(`Session with id ${id} not found`);
    }

    return this.withInferredActiveAgentProvider(rows[0]);
  }

  async renameFromGeneratedTitle(id: number, name: string) {
    const nextName = name.trim();
    if (!nextName) {
      return this.findOne(id);
    }

    const current = await this.findOne(id);
    if (!this.isAutoGeneratedSessionName(current.name)) {
      return this.withInferredActiveAgentProvider(current);
    }

    const rows = await this.db
      .update(schema.sessions)
      .set({
        name: nextName,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.sessions.id, id))
      .returning();

    if (rows.length === 0) {
      throw new NotFoundException(`Session with id ${id} not found`);
    }

    const session = rows[0];
    this.emit('session-title-changed', {
      sessionId: id,
      name: session.name,
    });
    return this.withInferredActiveAgentProvider(session);
  }

  async updateClaudeSessionId(id: number, claudeSessionId: string) {
    const session = await this.findOne(id);

    if (
      session.claudeSessionId === claudeSessionId &&
      session.activeAgentProvider === 'claude'
    ) {
      return session;
    }

    const rows = await this.db
      .update(schema.sessions)
      .set({
        activeAgentProvider: 'claude',
        claudeSessionId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.sessions.id, id))
      .returning();

    if (rows.length === 0) {
      throw new NotFoundException(`Session with id ${id} not found`);
    }

    return this.withInferredActiveAgentProvider(rows[0]);
  }

  async updateCodexSessionId(id: number, codexSessionId: string) {
    const session = await this.findOne(id);

    if (
      session.codexSessionId === codexSessionId &&
      session.activeAgentProvider === 'codex'
    ) {
      return session;
    }

    const rows = await this.db
      .update(schema.sessions)
      .set({
        activeAgentProvider: 'codex',
        codexSessionId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.sessions.id, id))
      .returning();

    if (rows.length === 0) {
      throw new NotFoundException(`Session with id ${id} not found`);
    }

    return this.withInferredActiveAgentProvider(rows[0]);
  }

  async updatePiSessionPath(id: number, piSessionPath: string) {
    const session = await this.findOne(id);

    if (
      session.piSessionPath === piSessionPath &&
      session.activeAgentProvider === 'pi'
    ) {
      return session;
    }

    const rows = await this.db
      .update(schema.sessions)
      .set({
        activeAgentProvider: 'pi',
        piSessionPath,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.sessions.id, id))
      .returning();

    if (rows.length === 0) {
      throw new NotFoundException(`Session with id ${id} not found`);
    }

    return this.withInferredActiveAgentProvider(rows[0]);
  }

  async updateActiveAgentProvider(id: number, provider: AgentProviderId) {
    if (typeof provider !== 'string') {
      throw new BadRequestException('Provider must be a string');
    }

    const normalized = provider.trim();
    if (!normalized) {
      throw new BadRequestException('Provider must not be empty');
    }

    const session = await this.findOne(id);
    if (session.activeAgentProvider === normalized) {
      return session;
    }

    if (this.hasStartedAgentRuntime(session)) {
      throw new BadRequestException(
        'Provider can only be changed before the session is started',
      );
    }

    const rows = await this.db
      .update(schema.sessions)
      .set({
        activeAgentProvider: normalized,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.sessions.id, id))
      .returning();

    if (rows.length === 0) {
      throw new NotFoundException(`Session with id ${id} not found`);
    }

    return this.withInferredActiveAgentProvider(rows[0]);
  }

  private isAutoGeneratedSessionName(name: string | null | undefined): boolean {
    return typeof name === 'string' && /^Session \d+$/.test(name.trim());
  }

  private hasStartedAgentRuntime(session: {
    claudeSessionId?: string | null;
    codexSessionId?: string | null;
    piSessionPath?: string | null;
  }): boolean {
    return Boolean(
      (session.claudeSessionId && session.claudeSessionId !== '-1')
        || (session.codexSessionId && session.codexSessionId !== '-1')
        || (session.piSessionPath && session.piSessionPath !== '-1'),
    );
  }

  private withInferredActiveAgentProvider<
    T extends {
      activeAgentProvider?: string | null;
      claudeSessionId?: string | null;
      codexSessionId?: string | null;
      piSessionPath?: string | null;
    },
  >(session: T): T & { activeAgentProvider: AgentProviderId } {
    const hasClaude = Boolean(session.claudeSessionId && session.claudeSessionId !== '-1');
    const hasCodex = Boolean(session.codexSessionId && session.codexSessionId !== '-1');
    const hasPi = Boolean(session.piSessionPath && session.piSessionPath !== '-1');
    const persisted = session.activeAgentProvider?.trim();

    return {
      ...session,
      activeAgentProvider:
        persisted && (persisted !== 'claude' || hasClaude || (!hasCodex && !hasPi))
          ? persisted
          : hasPi
            ? 'pi'
            : hasCodex
              ? 'codex'
              : 'claude',
    };
  }

  async markWorktreeContextInjected(id: number) {
    const rows = await this.db
      .update(schema.sessions)
      .set({
        hasInjectedWorktreeContext: true,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.sessions.id, id))
      .returning();

    if (rows.length === 0) {
      throw new NotFoundException(`Session with id ${id} not found`);
    }

    return this.withInferredActiveAgentProvider(rows[0]);
  }

  async updateStatus(id: number, status: string) {
    if (!VALID_STATUSES.includes(status as SessionStatus)) {
      throw new BadRequestException(
        `Invalid status: ${status}. Must be one of: ${VALID_STATUSES.join(', ')}`,
      );
    }

    const rows = await this.db
      .update(schema.sessions)
      .set({
        status,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.sessions.id, id))
      .returning();

    if (rows.length === 0) {
      throw new NotFoundException(`Session with id ${id} not found`);
    }

    this.emit('session-status-changed', { sessionId: id, status });
    return this.withInferredActiveAgentProvider(rows[0]);
  }

  async markCompletionUnreviewed(
    id: number,
    completionKind: SessionCompletionKind = 'completed',
  ) {
    if (!VALID_COMPLETION_KINDS.includes(completionKind)) {
      throw new BadRequestException(
        `Invalid completion kind: ${completionKind}. Must be one of: ${VALID_COMPLETION_KINDS.join(', ')}`,
      );
    }

    const rows = await this.db
      .update(schema.sessions)
      .set({
        hasUnreviewedCompletion: true,
        lastCompletionAt: new Date().toISOString(),
        lastCompletionKind: completionKind,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.sessions.id, id))
      .returning();

    if (rows.length === 0) {
      throw new NotFoundException(`Session with id ${id} not found`);
    }

    const session = rows[0];
    this.emit('session-completion-changed', {
      sessionId: id,
      hasUnreviewedCompletion: session.hasUnreviewedCompletion,
      lastCompletionAt: session.lastCompletionAt,
      lastCompletionKind: session.lastCompletionKind,
    });
    return this.withInferredActiveAgentProvider(session);
  }

  async markCompletionReviewed(id: number) {
    const rows = await this.db
      .update(schema.sessions)
      .set({
        hasUnreviewedCompletion: false,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.sessions.id, id))
      .returning();

    if (rows.length === 0) {
      throw new NotFoundException(`Session with id ${id} not found`);
    }

    const session = rows[0];
    this.emit('session-completion-changed', {
      sessionId: id,
      hasUnreviewedCompletion: session.hasUnreviewedCompletion,
      lastCompletionAt: session.lastCompletionAt,
      lastCompletionKind: session.lastCompletionKind,
    });
    return this.withInferredActiveAgentProvider(session);
  }

  async markLastStateChange(id: number, at: string = new Date().toISOString()) {
    const rows = await this.db
      .update(schema.sessions)
      .set({
        lastStateChangeAt: at,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.sessions.id, id))
      .returning();

    if (rows.length === 0) {
      throw new NotFoundException(`Session with id ${id} not found`);
    }

    const session = rows[0];
    this.emit('session-last-state-change-changed', {
      sessionId: id,
      lastStateChangeAt: session.lastStateChangeAt,
    });
    return this.withInferredActiveAgentProvider(session);
  }

  async delete(id: number) {
    await this.findOne(id);

    await this.agentRuntimeCleanup.cleanupSession(id);

    // 1. Kill the PTY process if running
    this.ptyManager.kill(id);

    // 2. Kill the tmux session if exists
    this.ptyManager.killTmuxSession(id);

    // 3. Delete from database
    const rows = await this.db
      .delete(schema.sessions)
      .where(eq(schema.sessions.id, id))
      .returning();

    if (rows.length === 0) {
      throw new NotFoundException(`Session with id ${id} not found`);
    }

    return this.withInferredActiveAgentProvider(rows[0]);
  }

  async deleteByWorktreePath(worktreePath: string) {
    // Kill PTY/tmux for all sessions in this worktree before deleting
    const sessions = await this.findByWorktreePath(worktreePath);
    for (const session of sessions) {
      this.ptyManager.kill(session.id);
      this.ptyManager.killTmuxSession(session.id);
    }

    await this.db
      .delete(schema.sessions)
      .where(eq(schema.sessions.worktreePath, worktreePath));
  }

  async deleteByRepoAndWorktreePath(repoId: number, worktreePath: string) {
    const sessions = await this.findByRepoAndWorktreePath(repoId, worktreePath);
    for (const session of sessions) {
      this.ptyManager.kill(session.id);
      this.ptyManager.killTmuxSession(session.id);
    }

    await this.db
      .delete(schema.sessions)
      .where(
        and(
          eq(schema.sessions.repoId, repoId),
          eq(schema.sessions.worktreePath, worktreePath),
        ),
      );
  }

  async archive(id: number) {
    // 1. Kill the PTY process if running
    this.ptyManager.kill(id);

    // 2. Kill the tmux session if exists
    this.ptyManager.killTmuxSession(id);

    // 3. Update status to archived
    return this.updateStatus(id, 'archived');
  }

  async reset(id: number) {
    const session = await this.findOne(id);

    // 1. Archive current
    await this.archive(id);

    // 2. Create new session in same worktree
    const newSession = await this.create({
      repoId: session.repoId,
      branchName: session.branchName,
      worktreePath: session.worktreePath,
      name: `${session.name} (reset)`,
    });

    return newSession;
  }

  /**
   * Fork a session - creates a new session in the same worktree.
   * The new session is independent and will spawn its own PTY.
   */
  async fork(id: number, name?: string) {
    const session = await this.findOne(id);

    // Generate fork name
    const forkName = name ?? `${session.name ?? 'Session'} (fork)`;

    // Create new session in same worktree
    const newSession = await this.create({
      repoId: session.repoId,
      branchName: session.branchName,
      worktreePath: session.worktreePath,
      name: forkName,
    });

    return newSession;
  }

  /**
   * Kill a session - terminates the PTY process but keeps session accessible.
   * Session status is set to 'stopped' (distinct from 'archived').
   */
  async kill(id: number) {
    // 1. Kill the PTY process if running
    this.ptyManager.kill(id);

    // 2. Kill the tmux session if exists
    this.ptyManager.killTmuxSession(id);

    // 3. Update status to stopped (NOT archived - session remains accessible)
    return this.updateStatus(id, 'stopped');
  }

  async start(id: number): Promise<{ success: boolean; resumed: boolean; error?: string }> {
    // Just return session info - actual PTY spawn happens via TerminalService
    // when WebSocket connects
    const session = await this.findOne(id);

    // Update status to indicate starting
    await this.updateStatus(id, 'active');

    return { success: true, resumed: false };
  }

  private async countByRepoAndBranch(repoId: number, branchName: string) {
    const result = await this.db
      .select({ count: count() })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.repoId, repoId),
          eq(schema.sessions.branchName, branchName),
        ),
      );

    return result[0].count;
  }
}
