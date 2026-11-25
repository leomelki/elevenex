import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
} from 'drizzle-orm';
import type { DrizzleDB } from '../database/database.provider.js';
import {
  sessionCompletionNotices as notices,
  sessionLaunches,
  sessions,
  workspaces,
} from '../database/schema/index.js';
import { sessionAgentProvider } from './session-provider.js';

type Notice = typeof notices.$inferSelect;
type Outcome = NonNullable<Notice['outcome']>;

/** The completion record belongs to the launch, even if its sidebar placement changes. */
export class SessionCompletionOutbox {
  constructor(private readonly db: DrizzleDB) {}

  waiting(sessionId: number) {
    return this.db
      .select({
        recipientId: notices.recipientId,
        actionKey: notices.actionKey,
        provider: sessions.activeAgentProvider,
        status: sessions.status,
        lastCompletionAt: sessions.lastCompletionAt,
        delivery: sessionLaunches.delivery,
      })
      .from(notices)
      .innerJoin(sessions, eq(sessions.id, notices.sessionId))
      .innerJoin(
        sessionLaunches,
        eq(sessionLaunches.sessionId, notices.sessionId),
      )
      .where(
        and(eq(notices.sessionId, sessionId), eq(notices.state, 'waiting')),
      )
      .get();
  }

  settle(sessionId: number, outcome: Outcome): number | undefined {
    return this.db
      .update(notices)
      .set({ state: 'ready', outcome })
      .where(
        and(eq(notices.sessionId, sessionId), eq(notices.state, 'waiting')),
      )
      .returning({ recipientId: notices.recipientId })
      .get()?.recipientId;
  }

  recipientForReadyNotice(sessionId: number): number | undefined {
    return this.db
      .select({ recipientId: notices.recipientId })
      .from(notices)
      .where(and(eq(notices.sessionId, sessionId), eq(notices.state, 'ready')))
      .get()?.recipientId;
  }

  status(sessionId: number, recipientId: number) {
    return this.db
      .select({ state: notices.state, outcome: notices.outcome })
      .from(notices)
      .where(
        and(
          eq(notices.sessionId, sessionId),
          eq(notices.recipientId, recipientId),
        ),
      )
      .get();
  }

  ready(recipientId: number, after = 0) {
    return this.db
      .select({ sessionId: notices.sessionId, outcome: notices.outcome })
      .from(notices)
      .where(
        and(
          eq(notices.recipientId, recipientId),
          eq(notices.state, 'ready'),
          gt(notices.sessionId, after),
        ),
      )
      .orderBy(asc(notices.sessionId))
      .limit(16)
      .all();
  }

  claim(recipientId: number, sessionIds: number[], provider: string): number[] {
    if (!sessionIds.length) return [];
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
              inArray(notices.sessionId, sessionIds),
            ),
          )
          .returning({ sessionId: notices.sessionId })
          .all()
          .map((row) => row.sessionId);
      },
      { behavior: 'immediate' },
    );
  }

  /** Recheck after async runtime and workspace reads. */
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
      .select({ sessionId: notices.sessionId, actionKey: notices.actionKey })
      .from(notices)
      .where(
        and(
          eq(notices.recipientId, recipientId),
          eq(notices.state, 'waiting'),
          eq(notices.actionDelivered, false),
          isNotNull(notices.actionKey),
          gt(notices.sessionId, after),
        ),
      )
      .orderBy(asc(notices.sessionId))
      .limit(16)
      .all();
  }

  claimActions(
    recipientId: number,
    provider: string,
    requests: readonly { sessionId: number; actionKey: string }[],
  ): number[] {
    if (!requests.length) return [];
    return this.db.transaction(
      (tx) => {
        if (!this.eligible(tx, recipientId, provider)) return [];
        // Once claimed, an uncertain send is never replayed for the same request.
        return requests.flatMap(({ sessionId, actionKey }) => {
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
        });
      },
      { behavior: 'immediate' },
    );
  }

  record(sessionIds: number[], state: 'accepted' | 'unconfirmed'): void {
    this.db
      .update(notices)
      .set({ state })
      .where(
        and(
          eq(notices.state, 'dispatching'),
          inArray(notices.sessionId, sessionIds),
        ),
      )
      .run();
  }

  consume(sessionId: number, recipientId: number): void {
    this.db
      .update(notices)
      .set({ state: 'consumed' })
      .where(
        and(
          eq(notices.sessionId, sessionId),
          eq(notices.recipientId, recipientId),
          inArray(notices.state, ['waiting', 'ready']),
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
    // A crash can occur after sending but before getting acceptance. Replaying
    // a possibly accepted prompt could start an unintended second turn.
    this.db
      .update(notices)
      .set({ state: 'unconfirmed' })
      .where(eq(notices.state, 'dispatching'))
      .run();
  }

  recoverable(state: 'waiting' | 'ready', after: number) {
    return this.db
      .select({
        sessionId: notices.sessionId,
        recipientId: notices.recipientId,
      })
      .from(notices)
      .where(and(eq(notices.state, state), gt(notices.sessionId, after)))
      .orderBy(asc(notices.sessionId))
      .limit(32)
      .all();
  }
}
