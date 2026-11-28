import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { ProjectsService } from '../projects/projects.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { TasksService } from '../tasks/tasks.service.js';

/** Confirmed desktop deletion owns cleanup before the metadata cascade. */
@Injectable()
export class DesktopProjectDeletionService {
  private readonly pending = new Map<number, Promise<void>>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly projects: ProjectsService,
    private readonly tasks: TasksService,
    private readonly sessions: SessionsService,
  ) {}

  delete(projectId: number): Promise<void> {
    const pending = this.pending.get(projectId);
    if (pending) return pending;
    const operation = this.deleteProject(projectId).finally(() => {
      this.pending.delete(projectId);
    });
    this.pending.set(projectId, operation);
    return operation;
  }

  private async deleteProject(projectId: number): Promise<void> {
    await this.projects.findOne(projectId);
    try {
      // Page task IDs and finish sequentially to bound Git/process work. The
      // task lifecycle owns repository locking and retains dirty/external files.
      let cursor = 0;
      for (;;) {
        const tasks = await this.db
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .innerJoin(
            schema.repos,
            eq(schema.repos.id, schema.workspaces.repoId),
          )
          .where(
            and(
              eq(schema.repos.projectId, projectId),
              eq(schema.workspaces.isDefault, false),
              isNull(schema.workspaces.archivedAt),
              gt(schema.workspaces.id, cursor),
            ),
          )
          .orderBy(asc(schema.workspaces.id))
          .limit(50);
        if (!tasks.length) break;
        for (const task of tasks) {
          await this.tasks.finish(task.id, true, undefined, {
            allowArchivedProject: true,
          });
          cursor = task.id;
        }
      }
      // Include legacy/default-workspace sessions and archived sessions whose
      // runtime may still need cleanup. Require every shutdown to succeed.
      await this.sessions.archiveAllByProject(projectId, true);
    } catch (cause: unknown) {
      throw new ConflictException(
        {
          code: 'project_cleanup_failed',
          message:
            'Could not stop all project processes. The project was kept. Try deleting it again.',
        },
        { cause },
      );
    }
    // Recheck inside the delete transaction: another window may have opened or
    // reopened a task while cleanup was awaiting Git/process work.
    await this.projects.delete(projectId, { requireFinishedTasks: true });
  }
}
