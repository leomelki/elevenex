import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import type { DrizzleDB } from '../database/database.provider.js';
import {
  sessionCompletionNotices as notices,
  sessionLaunches,
  sessionPromptReceipts as prompts,
  sessionReplyReturns,
  sessions,
  workspaces,
} from '../database/schema/index.js';
import { sessionAgentProvider } from './session-provider.js';

type Notice = typeof notices.$inferSelect;
type Outcome = NonNullable<Notice['outcome']>;

/** Completion ownership belongs to an assignment, independently of sidebar placement. */
export class SessionCompletionOutbox {
  constructor(private readonly db: DrizzleDB) {}

  launchMessageId(sessionId: number): string | undefined {
    return (
      this.db
        .select({ messageId: notices.messageId })
        .from(notices)
        .where(and(eq(notices.sessionId, sessionId), isNull(notices.promptId)))
        .get()?.messageId ?? undefined
    );
  }

  pending(sessionId: number, after = 0) {
    return this.db
      .select({
        id: notices.id,
        sessionId: notices.sessionId,
        recipientId: notices.recipientId,
        messageId: notices.messageId,
        promptId: notices.promptId,
        completionAfter: notices.completionAfter,
        actionKey: notices.actionKey,
        provider: sessions.activeAgentProvider,
        status: sessions.status,
        lastCompletionAt: sessions.lastCompletionAt,
        delivery: sql<
          string | null
        >`coalesce(${prompts.delivery}, ${sessionLaunches.delivery})`,
      })
      .from(notices)
      .innerJoin(sessions, eq(sessions.id, notices.sessionId))
      .leftJoin(
        sessionLaunches,
        eq(sessionLaunches.sessionId, notices.sessionId),
      )
      .leftJoin(prompts, eq(prompts.id, notices.promptId))
      .where(
        and(
          eq(notices.sessionId, sessionId),
          eq(notices.state, 'waiting'),
          gt(notices.id, after),
        ),
      )
      .orderBy(asc(notices.id))
      .limit(32)
      .all();
  }

  waiting(sessionId: number) {
    return this.pending(sessionId)[0];
  }

  promptDispositions(sessionId: number) {
    return this.db
      .select({ id: prompts.id, disposition: prompts.disposition })
      .from(prompts)
      .innerJoin(notices, eq(notices.promptId, prompts.id))
      .where(
        and(eq(prompts.sessionId, sessionId), eq(notices.state, 'waiting')),
      )
      .limit(64)
      .all();
  }

  settle(
    id: number,
    outcome: Outcome,
    reply?: { id: string; content?: string },
  ) {
    const notice = this.db
      .select()
      .from(notices)
      .where(eq(notices.id, id))
      .get();
    if (!notice || notice.state !== 'waiting') return;
    const returned =
      reply &&
      this.db
        .select({ id: sessionReplyReturns.itemId })
        .from(sessionReplyReturns)
        .where(
          and(
            eq(sessionReplyReturns.sessionId, notice.sessionId),
            eq(sessionReplyReturns.recipientId, notice.recipientId),
            eq(sessionReplyReturns.itemId, reply.id),
          ),
        )
        .get();
    return this.db
      .update(notices)
      .set({
        state: returned ? 'consumed' : 'ready',
        outcome,
        replyId: reply?.id,
        replyText: reply?.content?.trim().slice(0, 8_001),
      })
      .where(and(eq(notices.id, id), eq(notices.state, 'waiting')))
      .returning({ recipientId: notices.recipientId })
      .get()?.recipientId;
  }

  failSession(sessionId: number): void {
    this.db
      .update(notices)
      .set({ state: 'ready', outcome: 'failed' })
      .where(
        and(eq(notices.sessionId, sessionId), eq(notices.state, 'waiting')),
      )
      .run();
  }

  recipientForReadyNotice(sessionId: number) {
    return this.db
      .select({ recipientId: notices.recipientId })
      .from(notices)
      .where(and(eq(notices.sessionId, sessionId), eq(notices.state, 'ready')))
      .get()?.recipientId;
  }

  status(sessionId: number, recipientId: number) {
    return this.db
      .select({
        state: notices.state,
        outcome: notices.outcome,
        assignmentId: notices.id,
        promptId: notices.promptId,
      })
      .from(notices)
      .where(
        and(
          eq(notices.sessionId, sessionId),
          eq(notices.recipientId, recipientId),
        ),
      )
      .orderBy(desc(notices.id))
      .get();
  }

  latestReply(sessionId: number, recipientId: number, assignmentId?: number) {
    return this.db
      .select({
        promptId: notices.promptId,
        replyId: notices.replyId,
        replyText: notices.replyText,
      })
      .from(notices)
      .where(
        and(
          eq(notices.sessionId, sessionId),
          eq(notices.recipientId, recipientId),
          assignmentId === undefined ? undefined : eq(notices.id, assignmentId),
        ),
      )
      .orderBy(desc(notices.id))
      .get();
  }

  assignment(promptId: string) {
    return this.db
      .select({
        assignmentId: notices.id,
        state: notices.state,
        outcome: notices.outcome,
      })
      .from(notices)
      .where(eq(notices.promptId, promptId))
      .get();
  }

  ready(recipientId: number, after = 0) {
    return this.db
      .select({
        id: notices.id,
        sessionId: notices.sessionId,
        outcome: notices.outcome,
        replyId: notices.replyId,
        replyText: notices.replyText,
        messageId: notices.messageId,
      })
      .from(notices)
      .where(
        and(
          eq(notices.recipientId, recipientId),
          eq(notices.state, 'ready'),
          gt(notices.id, after),
        ),
      )
      .orderBy(asc(notices.id))
      .limit(16)
      .all();
  }

  claim(recipientId: number, ids: number[], provider: string): number[] {
    if (!ids.length) return [];
    return this.db.transaction(
      (tx) => {
        if (!this.eligible(tx, recipientId, provider)) return [];
        return tx
          .update(notices)
          .set({ state: 'dispatching' })
          .where(
            and(
              eq(notices.recipientId, recipientId),
              eq(notices.state, 'ready'),
              inArray(notices.id, ids),
            ),
          )
          .returning({ id: notices.id })
          .all()
          .map((row) => row.id);
      },
      { behavior: 'immediate' },
    );
  }

  private eligible(
    tx: Pick<DrizzleDB, 'select'>,
    recipientId: number,
    provider: string,
  ): boolean {
    const recipient = tx
      .select({
        activeAgentProvider: sessions.activeAgentProvider,
        claudeSessionId: sessions.claudeSessionId,
        codexSessionId: sessions.codexSessionId,
        piSessionPath: sessions.piSessionPath,
        opencodeSessionId: sessions.opencodeSessionId,
        status: sessions.status,
        planMode: sessions.planMode,
        surface: sessions.surface,
        workspace: workspaces,
      })
      .from(sessions)
      .innerJoin(workspaces, eq(workspaces.id, sessions.workspaceId))
      .where(eq(sessions.id, recipientId))
      .get();
    return (
      !!recipient &&
      sessionAgentProvider(recipient) === provider &&
      recipient.status === 'active' &&
      !recipient.planMode &&
      recipient.surface === 'session' &&
      !recipient.workspace.archivedAt &&
      !recipient.workspace.taskFinishRequest &&
      recipient.workspace.linkStatus === 'linked' &&
      recipient.workspace.taskState === 'ready'
    );
  }

  setAction(sessionId: number, key: string | null): void {
    this.db
      .update(notices)
      .set({ actionKey: key, actionDelivered: false })
      .where(
        and(
          eq(notices.sessionId, sessionId),
          eq(notices.state, 'waiting'),
          key === null
            ? isNotNull(notices.actionKey)
            : or(isNull(notices.actionKey), ne(notices.actionKey, key)),
        ),
      )
      .run();
  }

  acknowledgeAction(sessionId: number, recipientId: number, key: string): void {
    this.db
      .update(notices)
      .set({ actionKey: key, actionDelivered: true })
      .where(
        and(
          eq(notices.sessionId, sessionId),
          eq(notices.recipientId, recipientId),
          eq(notices.state, 'waiting'),
          or(isNull(notices.actionKey), eq(notices.actionKey, key)),
        ),
      )
      .run();
  }

  readyActions(recipientId: number, after = 0) {
    return this.db
      .select({
        id: notices.id,
        sessionId: notices.sessionId,
        actionKey: notices.actionKey,
      })
      .from(notices)
      .where(
        and(
          eq(notices.recipientId, recipientId),
          eq(notices.state, 'waiting'),
          eq(notices.actionDelivered, false),
          isNotNull(notices.actionKey),
          gt(notices.id, after),
        ),
      )
      .orderBy(asc(notices.id))
      .limit(16)
      .all();
  }

  claimActions(
    recipientId: number,
    provider: string,
    requests: readonly { sessionId: number; actionKey: string }[],
  ): number[] {
    return this.db.transaction(
      (tx) => {
        if (!this.eligible(tx, recipientId, provider)) return [];
        return [
          ...new Set(
            requests.flatMap(({ sessionId, actionKey }) => {
              const result = tx
                .update(notices)
                .set({ actionDelivered: true })
                .where(
                  and(
                    eq(notices.sessionId, sessionId),
                    eq(notices.recipientId, recipientId),
                    eq(notices.state, 'waiting'),
                    eq(notices.actionKey, actionKey),
                    eq(notices.actionDelivered, false),
                  ),
                )
                .run();
              return result.changes ? [sessionId] : [];
            }),
          ),
        ];
      },
      { behavior: 'immediate' },
    );
  }

  record(ids: number[], state: 'accepted' | 'unconfirmed'): void {
    if (ids.length)
      this.db
        .update(notices)
        .set({ state })
        .where(and(eq(notices.state, 'dispatching'), inArray(notices.id, ids)))
        .run();
  }

  consume(
    sessionId: number,
    recipientId: number,
    replyId?: string,
    assignmentId?: number,
  ): void {
    this.db
      .update(notices)
      .set({ state: 'consumed' })
      .where(
        and(
          eq(notices.sessionId, sessionId),
          eq(notices.recipientId, recipientId),
          assignmentId === undefined ? undefined : eq(notices.id, assignmentId),
          inArray(notices.state, ['waiting', 'ready']),
          // Reading an old reply must never acknowledge a newly queued assignment.
          replyId === undefined
            ? undefined
            : or(
                eq(notices.replyId, replyId),
                and(isNull(notices.messageId), isNull(notices.replyId)),
              ),
        ),
      )
      .run();
  }

  discardForRecipient(recipientId: number): void {
    this.db
      .update(notices)
      .set({ state: 'consumed' })
      .where(
        and(
          eq(notices.recipientId, recipientId),
          inArray(notices.state, ['waiting', 'ready']),
        ),
      )
      .run();
  }

  recoverInterruptedDispatches(): void {
    this.db
      .update(notices)
      .set({ state: 'unconfirmed' })
      .where(eq(notices.state, 'dispatching'))
      .run();
  }

  recoverable(state: 'waiting' | 'ready', after: number) {
    return this.db
      .select({
        id: notices.id,
        sessionId: notices.sessionId,
        recipientId: notices.recipientId,
      })
      .from(notices)
      .where(and(eq(notices.state, state), gt(notices.id, after)))
      .orderBy(asc(notices.id))
      .limit(32)
      .all();
  }
}
