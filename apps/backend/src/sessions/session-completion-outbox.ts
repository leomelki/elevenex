import { and, asc, eq, gt, inArray } from 'drizzle-orm';
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
    return this.db.transaction(
      (tx) => {
        // Recheck eligibility at claim time after async runtime and workspace reads.
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
        if (
          !recipient ||
          sessionAgentProvider(recipient) !== provider ||
          recipient.status !== 'active' ||
          recipient.planMode ||
          recipient.surface !== 'session' ||
          recipient.workspace.archivedAt ||
          recipient.workspace.taskFinishRequest ||
          recipient.workspace.linkStatus !== 'linked' ||
          recipient.workspace.taskState !== 'ready'
        )
          return [];
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
