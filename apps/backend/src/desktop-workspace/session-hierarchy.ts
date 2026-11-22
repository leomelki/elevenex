import { BadRequestException } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';

/** Two levels keep the sidebar navigable. Validate and write under the same SQLite lock. */
export function moveSession(db: DrizzleDB, taskId: number, sessionId: number, parentSessionId: number | null) {
  if (parentSessionId !== null && (!Number.isSafeInteger(parentSessionId) || parentSessionId < 1))
    throw new BadRequestException('A parent session ID or null is required.');
  return db.transaction(tx => {
    const task = tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, taskId)).get();
    if (!task || task.archivedAt || task.taskState !== 'ready')
      throw new BadRequestException('Task is not ready for session changes.');
    const find = (id: number) => tx.select().from(schema.sessions).where(and(
      eq(schema.sessions.id, id), eq(schema.sessions.workspaceId, taskId),
      eq(schema.sessions.repoId, task.repoId), eq(schema.sessions.surface, 'session'),
      eq(schema.sessions.isTemporary, false), ne(schema.sessions.status, 'archived'),
    )).get();
    const session = find(sessionId);
    if (!session) throw new BadRequestException('Session must be active and belong to this task.');
    if (parentSessionId !== null) {
      const parent = find(parentSessionId);
      if (!parent || parent.id === sessionId) throw new BadRequestException('Choose another active session in this task.');
      if (parent.parentSessionId !== null || tx.select({ id: schema.sessions.id }).from(schema.sessions).where(and(eq(schema.sessions.workspaceId, taskId), eq(schema.sessions.parentSessionId, sessionId), ne(schema.sessions.status, 'archived'))).limit(1).get())
        throw new BadRequestException('Sessions support two levels. Move children to task level first.');
    }
    // A repeated delivery must not reorder an already-confirmed move.
    if (session.parentSessionId === parentSessionId) return session;
    const nestingOrder = parentSessionId === null ? 0 : (tx.select({ value: sql<number>`coalesce(max(${schema.sessions.nestingOrder}), 0)` }).from(schema.sessions).where(and(eq(schema.sessions.workspaceId, taskId), eq(schema.sessions.parentSessionId, parentSessionId))).get()?.value ?? 0) + 1;
    if (parentSessionId !== null) tx.update(schema.sessions).set({ parentSessionId: null }).where(and(eq(schema.sessions.parentSessionId, sessionId), eq(schema.sessions.status, 'archived'))).run();
    return tx.update(schema.sessions).set({ parentSessionId, nestingOrder, folderId: null, updatedAt: new Date().toISOString() })
      .where(eq(schema.sessions.id, sessionId)).returning().get();
  });
}

/** Indexed scalar lookup, evaluated only for the bounded page being returned. */
export const sessionChildCount = sql<number>`(select count(*) from sessions child where child.workspace_id = sessions.workspace_id and child.parent_session_id = sessions.id and child.status != 'archived' and child.surface = 'session' and child.is_temporary = 0)`;
