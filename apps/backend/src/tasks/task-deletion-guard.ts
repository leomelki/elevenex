import { ConflictException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';

/** Container deletion must not orphan preparation jobs or skip task cleanup. */
export function assertTaskHistoryCanBeDeleted(
  db: Pick<DrizzleDB, 'select'>,
  scope: { repoId: number } | { projectId: number },
) {
  const active = db
    .select({ taskId: schema.workspaces.id })
    .from(schema.workspaces)
    .innerJoin(schema.repos, eq(schema.workspaces.repoId, schema.repos.id))
    .where(
      and(
        eq(schema.workspaces.isDefault, false),
        isNull(schema.workspaces.archivedAt),
        'repoId' in scope
          ? eq(schema.workspaces.repoId, scope.repoId)
          : eq(schema.repos.projectId, scope.projectId),
      ),
    )
    .limit(1)
    .get();
  if (active)
    throw new ConflictException({
      code: 'active_tasks',
      message:
        'Finish active tasks before permanently deleting their repository or project.',
      taskId: active.taskId,
    });
}
