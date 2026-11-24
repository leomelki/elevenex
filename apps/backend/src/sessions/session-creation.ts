import { ConflictException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { DrizzleDB } from '../database/database.provider.js';
import {
  sessionLaunches,
  sessions,
  workspaces,
} from '../database/schema/index.js';
import { nextNestingOrder } from './session-hierarchy.js';

export interface SessionLaunchRequest {
  key: string;
  fingerprint: string;
  hasPrompt: boolean;
}

export type SessionLaunchDelivery =
  (typeof sessionLaunches.$inferSelect)['delivery'];

export function readSessionLaunch(
  db: Pick<DrizzleDB, 'select'>,
  request: SessionLaunchRequest,
) {
  const launch = db
    .select()
    .from(sessionLaunches)
    .where(eq(sessionLaunches.key, request.key))
    .get();
  if (launch && launch.fingerprint !== request.fingerprint)
    throw new ConflictException({
      code: 'session_request_conflict',
      message: 'This requestId was already used with different session inputs.',
    });
  return launch;
}

/** Commit the visible row, its ordering and its retry receipt together. */
export function insertTaskSession(
  db: DrizzleDB,
  values: typeof sessions.$inferInsert & { workspaceId: number },
  callerSessionId: number | undefined,
  launch: SessionLaunchRequest | undefined,
) {
  return db.transaction(
    (tx) => {
      const prior = launch && readSessionLaunch(tx, launch);
      if (prior) return { sessionId: prior.sessionId, created: false };

      const task = tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, values.workspaceId))
        .get();
      if (
        !task ||
        task.repoId !== values.repoId ||
        task.isDefault ||
        task.archivedAt ||
        task.linkStatus !== 'linked' ||
        task.taskState !== 'ready' ||
        task.path !== values.worktreePath
      )
        throw new ConflictException(
          'The task checkout changed while creating the session.',
        );

      const caller =
        callerSessionId === undefined
          ? undefined
          : tx
              .select({
                id: sessions.id,
                status: sessions.status,
                parentSessionId: sessions.parentSessionId,
              })
              .from(sessions)
              .where(
                and(
                  eq(sessions.id, callerSessionId),
                  eq(sessions.workspaceId, values.workspaceId),
                  eq(sessions.repoId, values.repoId),
                  eq(sessions.surface, 'session'),
                  eq(sessions.isTemporary, false),
                ),
              )
              .get();
      if (caller?.status === 'archived')
        throw new ConflictException('The delegating session was archived.');

      if (caller) {
        // The desktop shows two levels. Siblings can delegate while retaining
        // their own identity as sender and sharing the same visual group.
        const parentSessionId = caller.parentSessionId ?? caller.id;
        values = {
          ...values,
          parentSessionId,
          nestingOrder: nextNestingOrder(
            tx,
            values.workspaceId,
            parentSessionId,
          ),
          delegatedBySessionId: caller.id,
        };
      }

      const { id: sessionId } = tx
        .insert(sessions)
        .values(values)
        .returning({ id: sessions.id })
        .get();
      if (launch)
        tx.insert(sessionLaunches)
          .values({
            key: launch.key,
            fingerprint: launch.fingerprint,
            sessionId,
            delivery: launch.hasPrompt ? 'ready' : null,
          })
          .run();
      return { sessionId, created: true };
    },
    { behavior: 'immediate' },
  );
}
