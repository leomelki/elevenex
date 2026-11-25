import { isWorkspacePriorityStatus, type WorkspaceSession, type WorkspaceSessionPage } from '@elevenex/shared';
import { and, asc, desc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../database/database.provider.js';
import { sessions } from '../database/schema/index.js';
import { sessionChildCount } from '../sessions/session-hierarchy.js';

export interface SidebarSessionRow {
  readonly session: typeof sessions.$inferSelect;
  readonly childCount: number;
}

/** Page only live IDs and indexed, unseen completions. The same activity
 * projection as the ordinary sidebar decides which candidates still qualify. */
export async function sidebarPriorityPage(
  db: DrizzleDB,
  taskId: number,
  limit: number,
  beforeId: number | null,
  liveIds: readonly number[],
  project: (rows: readonly SidebarSessionRow[]) => WorkspaceSession[],
): Promise<WorkspaceSessionPage> {
  const eligibility = and(
    eq(sessions.workspaceId, taskId),
    eq(sessions.surface, 'session'),
    eq(sessions.isTemporary, false),
    ne(sessions.status, 'archived'),
  );
  const before = beforeId === null ? undefined : lt(sessions.id, beforeId);
  // Keep the literal predicate aligned with the partial index.
  const unseen = db.select({ id: sessions.id }).from(sessions)
    .where(and(eligibility, before, sql`has_unreviewed_completion = 1 and last_completion_at is not null`))
    .orderBy(desc(sessions.id)).limit(limit + 1);
  // CROSS JOIN drives primary-key lookups from the live IDs. An IN predicate
  // can cause SQLite to scan the entire task via the workspace activity index.
  const live = liveIds.length ? db.select({ id: sessions.id })
    .from(sql`json_each(${JSON.stringify(liveIds)}) as live_ids`)
    .crossJoin(sessions)
    .where(and(eligibility, before, eq(sessions.id, sql`live_ids.value`)))
    .orderBy(desc(sessions.id)).limit(limit + 1) : null;
  const candidates = await db.select({ session: sessions, childCount: sessionChildCount }).from(sessions)
    .where(or(inArray(sessions.id, unseen), live ? inArray(sessions.id, live) : undefined))
    .orderBy(desc(sessions.id)).limit(limit + 1);

  const items = project(candidates.slice(0, limit))
    .filter((session) => isWorkspacePriorityStatus(session.turnStatus ?? session.status));
  const itemIds = new Set(items.map((session) => session.id));
  const parentIds = [...new Set(items.flatMap(({ parentSessionId }) =>
    parentSessionId != null && !itemIds.has(parentSessionId) ? [parentSessionId] : [],
  ))];
  const parents = parentIds.length
    ? await db.select({ session: sessions, childCount: sessionChildCount }).from(sessions)
        .where(and(eligibility, inArray(sessions.id, parentIds))).orderBy(asc(sessions.id))
    : [];
  return {
    items: items.reverse(),
    parentSessions: project(parents),
    nextCursor: candidates.length > limit ? String(candidates[limit - 1].session.id) : null,
  };
}
