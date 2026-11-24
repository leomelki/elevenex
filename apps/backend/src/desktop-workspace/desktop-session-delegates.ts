import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { DelegatedSessionWork, SessionAgentContext, SessionAgentReference, SessionAgentStatus, SessionChildSummary } from '@elevenex/shared';
import { WORKSPACE_ARCHIVE_AGENT_LIMIT } from '@elevenex/shared';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import { sessionLaunches, sessionReplyReturns, sessions } from '../database/schema/index.js';
import { sessionAgentReference } from '../sessions/session-agent-message.js';
import { sessionAgentProvider } from '../sessions/session-provider.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';
import { DesktopWorkspaceActivityService } from './desktop-workspace-activity.service.js';
import { inactiveSessionStatus } from './desktop-session-status.js';

type Session = typeof sessions.$inferSelect;
const MAX_LIVE = 16;
const MAX_RECENT = 12;
const MAX_ROUTING = 4096;
const usable = and(eq(sessions.surface, 'session'), eq(sessions.isTemporary, false), ne(sessions.status, 'archived'));

/** Read indexed, scalar projections for the selected conversation and visible navigation pages. */
@Injectable()
export class DesktopSessionDelegates {
  private readonly routing = new Map<number, number | null>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly activity: DesktopWorkspaceActivityService,
    private readonly runtimeSessions: SessionsService,
    private readonly registry: AgentRuntimeRegistryService,
  ) {}

  onUpdate(changed: (parentId: number) => void): () => void {
    return this.activity.delegation.observe((id, semantic) => {
      const parent = this.parentOf(id, semantic);
      if (parent) changed(parent);
    });
  }

  parentOf(id: number, discover = true): number | null {
    const cached = this.routing.get(id);
    if (!discover || cached !== undefined) return cached ?? null;
    const row = this.db.select({ parent: sessions.delegatedBySessionId }).from(sessions).where(eq(sessions.id, id)).get();
    const parent = row?.parent ?? null;
    if (row) this.remember(id, parent);
    return parent;
  }

  private remember(id: number, parent: number | null): void {
    this.routing.delete(id);
    this.routing.set(id, parent);
    if (this.routing.size > MAX_ROUTING) this.routing.delete(this.routing.keys().next().value!);
  }

  read(session: Session, archived: boolean): {
    sessions?: readonly DelegatedSessionWork[];
    totalSessionsRunning?: number;
    delegation?: SessionAgentContext;
  } {
    const parent = this.parentReferences([session], session.workspaceId).get(session.id);
    const { selection } = sessionAgentReference(session);
    const returns = this.returned(session.id);
    const delegation = parent || returns.length ? {
      ...(parent ? { parent, selection } : {}),
      ...(parent && !archived && this.runtimeSessions.delegationHandoffs.waiting(parent.sessionId, session.id)
        ? { parentWaiting: true as const } : {}),
      ...(returns.length ? { returns } : {}),
    } : undefined;
    if (!session.workspaceId || archived) return { delegation };
    const filter = and(eq(sessions.delegatedBySessionId, session.id), eq(sessions.workspaceId, session.workspaceId), usable);
    const query = () => this.db.select({ session: sessions, delivery: sessionLaunches.delivery })
      .from(sessions).leftJoin(sessionLaunches, eq(sessionLaunches.sessionId, sessions.id));
    const recent = query().where(filter).orderBy(desc(sessions.id)).limit(MAX_RECENT + MAX_LIVE).all();
    const activeIds = this.activity.transientIds();
    const extra = activeIds.length ? query().where(and(filter, inArray(sessions.id, activeIds))).all() : [];
    const rows = [...new Map([...extra, ...recent].map(row => [row.session.id, row])).values()];
    const live: DelegatedSessionWork[] = [], settled: DelegatedSessionWork[] = [];
    for (const { session: child, delivery } of rows) {
      this.remember(child.id, session.id);
      const progress = this.activity.delegation.get(child.id);
      const status = this.status(child, delivery);
      if (status === 'pending' && delivery === null && child.status === 'created') continue;
      const reference = sessionAgentReference(child);
      const identity = reference.selection;
      const view: DelegatedSessionWork = {
        session: identity ? { ...reference, selection: { ...identity,
          ...(progress?.model ? { model: progress.model } : {}),
          ...(progress?.effort ? { effort: progress.effort } : {}),
        } } : reference,
        status, detail: progress?.detail ?? '',
        startedAt: progress?.startedAt ?? (delivery !== null && child.lastCompletionAt ? child.createdAt : null),
        endedAt: status === 'completed' || status === 'error' || status === 'stopped'
          ? progress?.endedAt ?? child.lastCompletionAt : null,
        toolUses: progress?.toolUses, tokens: progress?.tokens, delivered: progress?.deliveries,
      };
      if (status === 'pending' || status === 'running' || status === 'waiting' || status === 'paused') live.push(view);
      else settled.push(view);
    }
    const relevant = [
      ...live.sort((a, b) => Number(b.status === 'waiting') - Number(a.status === 'waiting') || a.session.sessionId - b.session.sessionId).slice(0, MAX_LIVE),
      ...settled.sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? '') || b.session.sessionId - a.session.sessionId).slice(0, MAX_RECENT),
    ];
    return { delegation, ...(relevant.length ? { sessions: relevant, totalSessionsRunning: live.length } : {}) };
  }

  private status(child: Session, delivery: typeof sessionLaunches.$inferSelect['delivery']): SessionAgentStatus {
    const progress = this.activity.delegation.get(child.id);
    const state = this.activity.turnStatus(child);
    if (child.status === 'stopped') return 'stopped';
    if (state === 'attention') return 'waiting';
    if (state === 'running') return 'running';
    if (delivery === 'failed' || state === 'failed') return 'error';
    if (progress?.interrupted) return 'stopped';
    if (progress?.paused) return 'paused';
    if (state === 'queued' || delivery === 'ready' || delivery === 'dispatching' ||
        (delivery === 'accepted' && !child.lastCompletionAt && !progress?.endedAt)) return 'pending';
    return 'completed';
  }

  parentReferences(rows: readonly Session[], taskId: number | null): ReadonlyMap<number, SessionAgentReference> {
    const ids = [...new Set(rows.flatMap(row => row.delegatedBySessionId ?? []))];
    if (!taskId || !ids.length) return new Map();
    const parents = this.db.select().from(sessions)
      .where(and(eq(sessions.workspaceId, taskId), eq(sessions.surface, 'session'), inArray(sessions.id, ids))).all();
    const byId = new Map(parents.map(row => [row.id, sessionAgentReference(row)]));
    return new Map(rows.flatMap(row => {
      const parent = row.delegatedBySessionId ? byId.get(row.delegatedBySessionId) : undefined;
      return parent ? [[row.id, parent] as const] : [];
    }));
  }

  private returned(sessionId: number) {
    const recipient = alias(sessions, 'recipient');
    return this.db.select({ receipt: sessionReplyReturns, recipient }).from(sessionReplyReturns)
      .innerJoin(recipient, eq(recipient.id, sessionReplyReturns.recipientId))
      .where(eq(sessionReplyReturns.sessionId, sessionId))
      .orderBy(desc(sessionReplyReturns.at)).limit(MAX_RECENT).all()
      .map(({ receipt, recipient }) => ({ itemId: receipt.itemId, at: receipt.at, recipient: sessionAgentReference(recipient) }));
  }

  sidebarDetail(row: Session, parent: SessionAgentReference) {
    const detail = this.activity.delegation.get(row.id)?.detail;
    return {
      ...(detail ? { delegationDetail: detail } : {}),
      ...(this.runtimeSessions.delegationHandoffs.waiting(parent.sessionId, row.id) ? { parentWaiting: true as const } : {}),
    };
  }

  private transientChildren(taskId: number, parents: readonly number[]): Session[] {
    const ids = this.activity.transientIds();
    return ids.length ? this.db.select().from(sessions).where(and(
      eq(sessions.workspaceId, taskId), usable, inArray(sessions.parentSessionId, parents), inArray(sessions.id, ids),
    )).all() : [];
  }

  private liveAgent(child: Session, status = this.activity.turnStatus(child)): boolean {
    return !!child.delegatedBySessionId && (status === 'running' || status === 'attention');
  }

  async stopChildren(taskId: number, parentId: number, approved: readonly number[]): Promise<boolean> {
    const children = this.transientChildren(taskId, [parentId]).filter(child => this.liveAgent(child));
    if (children.length !== approved.length || children.some(child => !approved.includes(child.id))) return false;
    // Stop only the confirmed turns. The sessions, their transcripts and drafts stay available.
    for (const child of children) {
      await this.registry.getProvider(sessionAgentProvider(child)).interrupt(child.id);
      this.runtimeSessions.emit('session-turn-interrupted', { sessionId: child.id });
    }
    return true;
  }

  childSummaries(taskId: number, parents: readonly number[]): ReadonlyMap<number, {
    childSummary?: SessionChildSummary; activeChildAgents?: readonly number[];
  }> {
    if (!parents.length) return new Map();
    const filter = and(eq(sessions.workspaceId, taskId), usable, inArray(sessions.parentSessionId, parents));
    const done = sql<number>`sum(case when ${sessions.lastCompletionAt} is not null or ${sessions.hasUnreviewedCompletion} = 1
      or ${sessions.status} in ('active','stopped')
      or (coalesce(trim(${sessions.claudeSessionId}), '') not in ('','-1'))
      or (coalesce(trim(${sessions.codexSessionId}), '') not in ('','-1'))
      or (coalesce(trim(${sessions.piSessionPath}), '') not in ('','-1'))
      or (coalesce(trim(${sessions.opencodeSessionId}), '') not in ('','-1'))
      then 1 else 0 end)`;
    const counts = new Map(this.db.select({ id: sessions.parentSessionId, done }).from(sessions)
      .where(filter).groupBy(sessions.parentSessionId).all()
      .map(row => [row.id, { attention: 0, failed: 0, running: 0, done: row.done, active: [] as number[] }]));
    for (const child of this.transientChildren(taskId, parents)) {
      const counter = counts.get(child.parentSessionId);
      const status = this.activity.turnStatus(child);
      if (!counter || (status !== 'attention' && status !== 'failed' && status !== 'running')) continue;
      counter[status]++;
      if (counter.active.length <= WORKSPACE_ARCHIVE_AGENT_LIMIT && this.liveAgent(child, status))
        counter.active.push(child.id);
      if (inactiveSessionStatus(child) !== 'queued') counter.done--;
    }
    const order = ['attention', 'failed', 'running', 'done'] as const;
    return new Map(parents.flatMap(id => {
      const count = counts.get(id);
      const status = count && order.find(status => count[status] > 0);
      return count && status ? [[id, {
        childSummary: { status, count: count[status] },
        ...(count.active.length && count.active.length <= WORKSPACE_ARCHIVE_AGENT_LIMIT ? { activeChildAgents: count.active } : {}),
      }] as const] : [];
    }));
  }
}
