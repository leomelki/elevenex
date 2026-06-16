import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import {
  DEFAULT_BROWSER_ISOLATION_MODE,
  DEFAULT_BROWSER_ISOLATION_SHARED_GLOBS,
} from '../browser-isolation/browser-isolation.defaults.js';
import { SessionsService } from '../sessions/sessions.service.js';

export type ProjectListState = 'active' | 'archived' | 'all';

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly sessionsService: SessionsService,
  ) {}

  async findAll(state: ProjectListState = 'active') {
    const notSystem = eq(schema.projects.isSystem, false);
    if (state === 'all') {
      return this.db.select().from(schema.projects).where(notSystem);
    }

    return this.db
      .select()
      .from(schema.projects)
      .where(
        and(
          notSystem,
          state === 'archived'
            ? isNotNull(schema.projects.archivedAt)
            : isNull(schema.projects.archivedAt),
        ),
      );
  }

  async findOne(id: number) {
    const rows = await this.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id));

    if (rows.length === 0) {
      throw new NotFoundException(`Project with id ${id} not found`);
    }
    return rows[0];
  }

  async findSystemByName(name: string) {
    const rows = await this.db
      .select()
      .from(schema.projects)
      .where(and(eq(schema.projects.name, name), eq(schema.projects.isSystem, true)));
    return rows[0] ?? null;
  }

  async create(name: string, options: { isSystem?: boolean } = {}) {
    try {
      return this.db.transaction((tx) => {
        const rows = tx
          .insert(schema.projects)
          .values({ name, isSystem: options.isSystem ?? false })
          .returning()
          .all();
        const project = rows[0];

        tx.insert(schema.browserIsolationSettings)
          .values({
            projectId: project.id,
            mode: DEFAULT_BROWSER_ISOLATION_MODE,
            sharedGlobs: JSON.stringify(DEFAULT_BROWSER_ISOLATION_SHARED_GLOBS),
          })
          .run();

        return project;
      });
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.message.includes('UNIQUE constraint failed')
      ) {
        throw new ConflictException('Project name already exists');
      }
      throw error;
    }
  }

  async archive(id: number) {
    const project = await this.findOne(id);
    if (project.archivedAt) {
      return project;
    }

    const timestamp = new Date().toISOString();
    const rows = await this.db
      .update(schema.projects)
      .set({
        archivedAt: timestamp,
        updatedAt: timestamp,
      })
      .where(eq(schema.projects.id, id))
      .returning();

    void this.sessionsService.archiveAllByProject(id).catch((error) => {
      this.logger.error(
        `Failed to archive sessions for project ${id}`,
        error instanceof Error ? error.stack : String(error),
      );
    });

    return rows[0];
  }

  async unarchive(id: number) {
    const project = await this.findOne(id);
    if (!project.archivedAt) {
      return project;
    }

    const timestamp = new Date().toISOString();
    const rows = await this.db
      .update(schema.projects)
      .set({
        archivedAt: null,
        updatedAt: timestamp,
      })
      .where(eq(schema.projects.id, id))
      .returning();

    return rows[0];
  }

  async assertProjectIsActive(id: number) {
    const project = await this.findOne(id);
    if (project.archivedAt) {
      throw new ConflictException(
        'Archived projects are read-only. Restore the project before making changes.',
      );
    }
    return project;
  }

  parseListState(value: string | undefined): ProjectListState {
    if (value === undefined || value === '' || value === 'active') {
      return 'active';
    }
    if (value === 'archived' || value === 'all') {
      return value;
    }
    throw new BadRequestException(
      'Project state must be active, archived, or all',
    );
  }

  async delete(id: number) {
    const rows = await this.db
      .delete(schema.projects)
      .where(eq(schema.projects.id, id))
      .returning();

    if (rows.length === 0) {
      throw new NotFoundException(`Project with id ${id} not found`);
    }
    return rows[0];
  }
}
