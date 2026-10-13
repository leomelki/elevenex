import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
} from 'drizzle-orm';
import type { DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';

export interface SessionFolderQuery {
  workspaceId?: number;
  state: 'active' | 'archived' | 'all';
  offset: number;
  limit: number;
}

/** Count memberships in SQL and fetch only the first 20 IDs per lifecycle group. */
export function querySessionFolders(
  db: DrizzleDB,
  repoId: number,
  options: SessionFolderQuery,
) {
  const where = and(
    eq(schema.sessionFolders.repoId, repoId),
    options.workspaceId === undefined
      ? undefined
      : eq(schema.sessionFolders.workspaceId, options.workspaceId),
    options.state === 'all'
      ? undefined
      : options.state === 'archived'
        ? isNotNull(schema.sessionFolders.archivedAt)
        : isNull(schema.sessionFolders.archivedAt),
  );
  return db.transaction((tx) => {
    const total = tx
      .select({ value: count() })
      .from(schema.sessionFolders)
      .where(where)
      .get()!.value;
    const folders = tx
      .select()
      .from(schema.sessionFolders)
      .where(where)
      .orderBy(asc(schema.sessionFolders.name), asc(schema.sessionFolders.id))
      .limit(options.limit)
      .offset(options.offset)
      .all();
    const folderIds = folders.map((folder) => folder.id);
    if (!folderIds.length) return { total, nextOffset: null, folders: [] };
    const memberWhere = and(
      inArray(schema.sessions.folderId, folderIds),
      eq(schema.sessions.surface, 'session'),
    );
    const archived = sql<number>`${schema.sessions.status} = 'archived'`;
    const counts = tx
      .select({ folderId: schema.sessions.folderId, archived, value: count() })
      .from(schema.sessions)
      .where(memberWhere)
      .groupBy(schema.sessions.folderId, archived)
      .all();
    const ranked = tx
      .select({
        id: schema.sessions.id,
        folderId: schema.sessions.folderId,
        status: schema.sessions.status,
        position:
          sql<number>`row_number() over (partition by ${schema.sessions.folderId}, (${archived}) order by ${schema.sessions.id})`.as(
            'position',
          ),
      })
      .from(schema.sessions)
      .where(memberWhere)
      .as('folder_members');
    const members = tx
      .select({
        id: ranked.id,
        folderId: ranked.folderId,
        status: ranked.status,
      })
      .from(ranked)
      .where(lte(ranked.position, 20))
      .all();
    return {
      total,
      nextOffset:
        options.offset + folders.length < total
          ? options.offset + folders.length
          : null,
      folders: folders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        repoId: folder.repoId,
        workspaceId: folder.workspaceId,
        archived: folder.archivedAt !== null,
        sessionCount:
          counts.find((row) => row.folderId === folder.id && row.archived === 0)
            ?.value ?? 0,
        archivedSessionCount:
          counts.find((row) => row.folderId === folder.id && row.archived === 1)
            ?.value ?? 0,
        sessionIds: members
          .filter(
            (row) => row.folderId === folder.id && row.status !== 'archived',
          )
          .map((row) => row.id),
        archivedSessionIds: members
          .filter(
            (row) => row.folderId === folder.id && row.status === 'archived',
          )
          .map((row) => row.id),
      })),
    };
  });
}
