import { and, count, desc, eq, isNull, ne } from 'drizzle-orm';
import type { DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';

export interface SessionHandleQuery {
  repoId?: number;
  projectId?: number;
  taskId?: number;
  folderId?: number;
  state?: 'active' | 'archived' | 'all';
  status?: string;
  needsReviewOnly?: boolean;
  limit?: number;
  offset?: number;
}

/** SQL pagination keeps tokens and provider configuration out of discovery reads. */
export async function querySessionHandles(
  db: DrizzleDB,
  options: SessionHandleQuery,
) {
  const state = options.state ?? 'active';
  const archived = state === 'archived' || options.status === 'archived';
  const where = and(
    eq(schema.sessions.surface, 'session'),
    options.repoId === undefined
      ? undefined
      : eq(schema.sessions.repoId, options.repoId),
    options.projectId === undefined
      ? undefined
      : eq(schema.repos.projectId, options.projectId),
    options.taskId === undefined
      ? undefined
      : eq(schema.sessions.workspaceId, options.taskId),
    options.folderId === undefined
      ? undefined
      : eq(schema.sessions.folderId, options.folderId),
    state === 'all'
      ? undefined
      : archived
        ? eq(schema.sessions.status, 'archived')
        : ne(schema.sessions.status, 'archived'),
    state === 'all' || archived
      ? undefined
      : isNull(schema.workspaces.archivedAt),
    options.status === undefined
      ? undefined
      : eq(schema.sessions.status, options.status),
    options.needsReviewOnly
      ? eq(schema.sessions.hasUnreviewedCompletion, true)
      : undefined,
  );
  const limit = Math.min(100, Math.max(1, options.limit ?? 25));
  const offset = Math.max(0, options.offset ?? 0);
  // Better-sqlite3 runs these small reads synchronously; a transaction gives
  // count/page a consistent snapshot without holding it across an await.
  return Promise.resolve(
    db.transaction((tx) => {
      const total = tx
        .select({ value: count() })
        .from(schema.sessions)
        .innerJoin(schema.repos, eq(schema.sessions.repoId, schema.repos.id))
        .leftJoin(
          schema.workspaces,
          eq(schema.sessions.workspaceId, schema.workspaces.id),
        )
        .where(where)
        .get()!.value;
      const rows = tx
        .select({
          id: schema.sessions.id,
          name: schema.sessions.name,
          status: schema.sessions.status,
          branchName: schema.sessions.branchName,
          activeAgentProvider: schema.sessions.activeAgentProvider,
          repoId: schema.sessions.repoId,
          workspaceId: schema.sessions.workspaceId,
          folderId: schema.sessions.folderId,
          worktreePath: schema.sessions.worktreePath,
          hasUnreviewedCompletion: schema.sessions.hasUnreviewedCompletion,
          lastStateChangeAt: schema.sessions.lastStateChangeAt,
          lastCompletionAt: schema.sessions.lastCompletionAt,
          claudeSessionId: schema.sessions.claudeSessionId,
          codexSessionId: schema.sessions.codexSessionId,
          piSessionPath: schema.sessions.piSessionPath,
          opencodeSessionId: schema.sessions.opencodeSessionId,
        })
        .from(schema.sessions)
        .innerJoin(schema.repos, eq(schema.sessions.repoId, schema.repos.id))
        .leftJoin(
          schema.workspaces,
          eq(schema.sessions.workspaceId, schema.workspaces.id),
        )
        .where(where)
        .orderBy(
          desc(schema.sessions.lastStateChangeAt),
          desc(schema.sessions.id),
        )
        .limit(limit)
        .offset(offset)
        .all();
      return {
        rows,
        total,
        nextOffset: offset + rows.length < total ? offset + rows.length : null,
      };
    }),
  );
}
